import crypto from 'node:crypto';
import { app, as, cast, inDays, makeRooms, models, request, setupDb, suite, uniq } from '../helpers/api.js';
import { billingService } from '../../src/modules/billing/billing.service.js';
import { env } from '../../src/config/environment.js';

const { BillingCharge, BillingAccount, Payment, Invoice, PaymentWebhookEvent, Refund } = models;
const sign = (body) => crypto.createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
const webhook = (event, signature) => { const raw = JSON.stringify(event); return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-signature', signature ?? sign(raw)).send(raw); };

suite('billing, invoices, payments and refunds (real MongoDB)', () => {
  setupDb();
  let c; let rooms; let b; let acct;
  const pay = (amountMinor, over = {}) => as(c.reception).post('/api/payments', { accountId: acct, amountMinor, method: 'CASH', idempotencyKey: uniq('pay-key-'), ...over });
  const issue = async () => { const d = (await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).body.data; return (await as(c.manager).post(`/api/invoices/${d.id}/issue`)).body.data; };

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'x'; // set in tests/setup.js
    const admin = await (await import('../helpers/api.js')).makeUser('ADMIN');
    await as(admin).post('/api/tax-rules', { code: 'VAT', name: 'VAT', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], effectiveFrom: '2020-01-01' });
  });
  beforeEach(async () => {
    c = await cast(); ({ rooms } = await makeRooms(c.admin, 1, { price: 1_000_000 }));
    const g = (await as(c.reception).post('/api/guests', { fullName: 'Pay Guest', phone: `+8494${String(Date.now()).slice(-7)}` })).body.data.guest;
    b = (await as(c.reception).post('/api/bookings', { rooms: [rooms[0].id], checkInDate: await inDays(10), checkOutDate: await inDays(12), adults: 2, guestIds: [g.id], customerId: String(c.customer._id) })).body.data;
    acct = b.billing.accountId;
  });

  describe('charges', () => {
    test('one source transaction can only ever be billed once (idempotent posting, even under concurrency)', async () => {
      const src = new (await import('mongoose')).default.Types.ObjectId();
      const post = () => billingService.postCharge({ billingAccountId: acct, bookingId: b.id, sourceType: 'FNB_ORDER', sourceId: src, sourceKey: 'order', category: 'FOOD_AND_BEVERAGE', description: 'Order', unitPriceMinor: 250_000 }, {});
      const results = await Promise.allSettled([post(), post(), post(), post(), post()]);
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.created)).toHaveLength(1);
      expect(await BillingCharge.countDocuments({ sourceType: 'FNB_ORDER', sourceId: src })).toBe(1);
      const r = await billingService.reconcile(acct);
      expect(r).toMatchObject({ cached: 2_250_000, consistent: true });
    });

    test('a room night cannot be billed twice; unique index backs it up', async () => {
      const night = await BillingCharge.findOne({ billingAccountId: acct });
      await expect(BillingCharge.create({ ...night.toObject(), _id: undefined })).rejects.toThrow(/duplicate key/i);
    });

    test('manual charges: only Manager/Admin; discounts above the approval limit need an Admin', async () => {
      const body = (over) => ({ category: 'DISCOUNT', description: 'Promo', unitPriceMinor: 100_000, ...over });
      expect((await as(c.reception).post(`/api/billing-accounts/${acct}/charges`, body())).status).toBe(403);
      expect((await as(c.customer).post(`/api/billing-accounts/${acct}/charges`, body())).status).toBe(403);
      const ok = await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, body());
      expect(ok.body.data).toMatchObject({ amountMinor: -100_000, category: 'DISCOUNT' }); // discounts are stored negative
      expect((await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, body({ unitPriceMinor: 6_000_000 }))).body.code).toBe('APPROVAL_LIMIT_EXCEEDED');
      expect((await as(c.admin).post(`/api/billing-accounts/${acct}/charges`, body({ unitPriceMinor: 6_000_000 }))).status).toBe(201);
      expect((await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, body({ category: 'ROOM' }))).status).toBe(422);
    });

    test('customers see their own account and charges only', async () => {
      expect((await as(c.customer).get(`/api/billing-accounts/${acct}`)).status).toBe(200);
      expect((await as(c.customer).get(`/api/billing-accounts/${acct}/charges`)).body.meta.total).toBe(2);
      expect((await as(c.customer2).get(`/api/billing-accounts/${acct}`)).status).toBe(404);
      expect((await as(c.customer2).get(`/api/billing-accounts/${acct}/charges`)).status).toBe(404);
      expect((await as(c.customer2).get('/api/billing-accounts')).body.meta.total).toBe(0);
      expect((await as(c.housekeeper).get(`/api/billing-accounts/${acct}`)).status).toBe(403);
    });
  });

  describe('invoices', () => {
    test('a draft can be regenerated as charges change; issuing locks the charges and numbers the invoice', async () => {
      const d1 = (await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).body.data;
      await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, { category: 'SURCHARGE', description: 'Late', unitPriceMinor: 100_000 });
      const d2 = (await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).body.data;
      expect(d2.id).toBe(d1.id);
      expect(d2.grandTotalMinor).toBe(2_000_000 + 100_000 + 200_000 + 10_000);
      const issued = (await as(c.manager).post(`/api/invoices/${d1.id}/issue`)).body.data;
      expect(issued.status).toBe('ISSUED');
      expect(await BillingCharge.countDocuments({ billingAccountId: acct, status: 'POSTED', invoiceId: issued.id })).toBe(3);
      expect((await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).body.code).toBe('INVOICE_EXISTS');
      expect((await as(c.manager).post(`/api/invoices/${d1.id}/issue`)).body.code).toBe('INVOICE_ALREADY_ISSUED');
      expect(await Invoice.countDocuments({ billingAccountId: acct, isActive: true })).toBe(1);
    });

    test('concurrent draft generation never creates two invoices', async () => {
      await Promise.all([1, 2, 3, 4].map(() => as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)));
      expect(await Invoice.countDocuments({ billingAccountId: acct, isActive: true })).toBe(1);
    });

    test('tax rates in force at issue time are used; history is not rewritten when rules change later', async () => {
      const issued = await issue();
      expect(issued.taxTotalMinor).toBe(200_000);
      await as(c.admin).post('/api/tax-rules', { code: 'LUX', name: 'Luxury', rateBps: 500, appliesTo: ['ROOM'], effectiveFrom: '2020-01-01' });
      expect((await as(c.manager).get(`/api/invoices/${issued.id}`)).body.data.taxTotalMinor).toBe(200_000); // unchanged
      await models.TaxRule.updateOne({ code: 'LUX' }, { $set: { isActive: false } });
    });

    test('adjustments: credit / debit, approval limit, cannot credit below zero; original figures untouched', async () => {
      const inv = await issue(); // 2,200,000 grand
      const adj = (over) => as(c.manager).post(`/api/invoices/${inv.id}/adjustments`, { adjustmentType: 'CREDIT', amountMinor: 200_000, reason: 'Noisy room', ...over });
      expect((await as(c.reception).post(`/api/invoices/${inv.id}/adjustments`, { adjustmentType: 'CREDIT', amountMinor: 1000, reason: 'nope' })).status).toBe(403);
      expect((await adj()).status).toBe(201);
      expect((await adj({ adjustmentType: 'DEBIT', amountMinor: 50_000, reason: 'Minibar' })).status).toBe(201);
      const got = (await as(c.manager).get(`/api/invoices/${inv.id}`)).body.data;
      expect(got).toMatchObject({ grandTotalMinor: 2_200_000, adjustmentsTotalMinor: -150_000, outstandingMinor: 2_050_000 });
      expect(got.adjustments).toHaveLength(2);
      expect((await adj({ amountMinor: 2_100_000 })).body.code).toBe('CREDIT_EXCEEDS_TOTAL');
      expect((await adj({ amountMinor: 6_000_000 })).body.code).toBe('APPROVAL_LIMIT_EXCEEDED');
      expect((await as(c.admin).post(`/api/invoices/${inv.id}/adjustments`, { adjustmentType: 'CREDIT', amountMinor: 2_050_000, reason: 'Full comp' })).status).toBe(201);
      expect((await as(c.manager).get(`/api/invoices/${inv.id}`)).body.data).toMatchObject({ status: 'PAID', outstandingMinor: 0 });
    });

    test('void: Admin only, refused once money was received; releases the charges for a corrected invoice', async () => {
      const inv = await issue();
      expect((await as(c.manager).post(`/api/invoices/${inv.id}/void`, { reason: 'wrong guest' })).status).toBe(403);
      await pay(100_000);
      expect((await as(c.admin).post(`/api/invoices/${inv.id}/void`, { reason: 'wrong guest' })).body.code).toBe('INVOICE_HAS_PAYMENTS');
      const pays = await Payment.find({ billingAccountId: acct });
      await as(c.admin).post(`/api/payments/${pays[0].id}/refund`, { amountMinor: 100_000, reason: 'void invoice' });
      expect((await as(c.admin).post(`/api/invoices/${inv.id}/void`, { reason: 'wrong guest' })).status).toBe(200);
      expect(await BillingCharge.countDocuments({ billingAccountId: acct, invoiceId: { $ne: null } })).toBe(0);
      expect((await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).status).toBe(201); // a new invoice is possible
    });

    test('customers see only their own ISSUED invoices; PDFs render for them', async () => {
      const inv = await issue();
      expect((await as(c.customer).get(`/api/invoices/${inv.id}`)).status).toBe(200);
      expect((await as(c.customer).get('/api/invoices')).body.meta.total).toBe(1);
      expect((await as(c.customer2).get(`/api/invoices/${inv.id}`)).status).toBe(404);
      expect((await as(c.customer2).get('/api/invoices')).body.meta.total).toBe(0);
      expect((await as(c.customer2).get(`/api/invoices/${inv.id}/pdf`)).status).toBe(404);
      const pdf = await as(c.customer).raw(`/api/invoices/${inv.id}/pdf`).parse((res, cb) => { const d = []; res.on('data', (x) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect((await as(c.manager).get(`/api/invoices?status=ISSUED&invoiceNumber=${inv.invoiceNumber}`)).body.meta.total).toBe(1);
    });

    test('overdue job flips unpaid invoices past their due date', async () => {
      const inv = await issue();
      await Invoice.updateOne({ _id: inv.id }, { $set: { dueAt: new Date(Date.now() - 1000) } });
      const { invoiceService } = await import('../../src/modules/invoices/invoice.service.js');
      expect(await invoiceService.markOverdue()).toBeGreaterThanOrEqual(1);
      expect((await as(c.manager).get(`/api/invoices/${inv.id}`)).body.data.status).toBe('OVERDUE');
      await pay(2_200_000);
      expect((await as(c.manager).get(`/api/invoices/${inv.id}`)).body.data.status).toBe('PAID');
    });
  });

  describe('payments', () => {
    test('staff-recorded payments: validation and authorization', async () => {
      expect((await pay(500_000)).status).toBe(201);
      expect((await pay(0)).status).toBe(422);
      expect((await pay(100, { method: 'ONLINE' })).status).toBe(422);
      expect((await pay(100, { idempotencyKey: 'short' })).status).toBe(422);
      expect((await as(c.customer).post('/api/payments', { accountId: acct, amountMinor: 100, method: 'CASH', idempotencyKey: uniq('customer-key-') })).status).toBe(403);
      expect((await as(c.housekeeper).post('/api/payments', { accountId: acct, amountMinor: 100, method: 'CASH', idempotencyKey: uniq('hk-key-') })).status).toBe(403);
      expect((await pay(2_000_000)).body.code).toBe('OVERPAYMENT'); // already 500,000 of 2,000,000 paid
    });

    test('IDEMPOTENCY: the same key (even concurrently) records one payment and returns the original', async () => {
      const key = uniq('idem-key-');
      const first = await pay(300_000, { idempotencyKey: key });
      const replay = await pay(300_000, { idempotencyKey: key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(first.body.data.id);
      const burst = await Promise.all([1, 2, 3, 4, 5].map(() => pay(100_000, { idempotencyKey: uniq('burst-key-') + 'same'.slice(0, 0) })));
      expect(burst.every((r) => r.status === 201)).toBe(true);
      const key2 = uniq('race-key-');
      const race = await Promise.all([1, 2, 3, 4].map(() => pay(50_000, { idempotencyKey: key2 })));
      expect(race.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(await Payment.countDocuments({ idempotencyKey: key2 })).toBe(1);
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(300_000 + 500_000 + 50_000);
    });

    test('account, invoice and ledger stay consistent: paid = sum(payments) - sum(refunds)', async () => {
      const inv = await issue();
      const p1 = (await pay(1_000_000)).body.data; await pay(500_000);
      await as(c.manager).post(`/api/payments/${p1.id}/refund`, { amountMinor: 300_000, reason: 'Overcharged', idempotencyKey: uniq('refund-key-') });
      const account = await BillingAccount.findById(acct);
      const sumPaid = (await Payment.find({ billingAccountId: acct })).reduce((a, p) => a + p.amountMinor, 0);
      const sumRef = (await Refund.find({ billingAccountId: acct })).reduce((a, r) => a + r.amountMinor, 0);
      expect(account.paidMinor).toBe(sumPaid - sumRef);
      expect((await as(c.manager).get(`/api/invoices/${inv.id}`)).body.data).toMatchObject({ paidMinor: 1_200_000, outstandingMinor: 2_200_000 - 1_200_000, status: 'PARTIALLY_PAID' });
    });

    test('refunds: limits, partial/full status, approval limit, idempotency, permissions', async () => {
      const p = (await pay(1_000_000)).body.data;
      const refund = (u, amountMinor, extra = {}) => as(u).post(`/api/payments/${p.id}/refund`, { amountMinor, reason: 'Guest complaint', ...extra });
      expect((await refund(c.reception, 100)).status).toBe(403);
      expect((await refund(c.customer, 100)).status).toBe(403);
      expect((await refund(c.manager, 400_000, { idempotencyKey: 'refund-A-0001' })).status).toBe(201);
      expect((await as(c.manager).get(`/api/payments/${p.id}`)).body.data).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 400_000 });
      const dup = await refund(c.manager, 400_000, { idempotencyKey: 'refund-A-0001' });
      expect(dup.status).toBe(200);
      expect((await refund(c.manager, 700_000)).body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      expect((await refund(c.manager, 600_000)).status).toBe(201);
      expect((await as(c.manager).get(`/api/payments/${p.id}`)).body.data.status).toBe('REFUNDED');
      expect((await refund(c.manager, 1)).body.code).toBe('PAYMENT_NOT_REFUNDABLE');
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(0);
      await as(c.admin).patch('/api/settings', { billing: { managerApprovalLimitMinor: 100 } });
      const p2 = (await pay(500_000)).body.data;
      expect((await as(c.manager).post(`/api/payments/${p2.id}/refund`, { amountMinor: 101, reason: 'Big refund' })).body.code).toBe('APPROVAL_LIMIT_EXCEEDED');
      expect((await as(c.admin).post(`/api/payments/${p2.id}/refund`, { amountMinor: 101, reason: 'Big refund' })).status).toBe(201);
      await as(c.admin).patch('/api/settings', { billing: { managerApprovalLimitMinor: 5_000_000 } });
    });

    test('payment history is private to the customer; staff can list all', async () => {
      const p = (await pay(100_000)).body.data;
      expect((await as(c.customer).get(`/api/payments/${p.id}`)).status).toBe(200);
      expect((await as(c.customer2).get(`/api/payments/${p.id}`)).status).toBe(404);
      expect((await as(c.customer).get('/api/payments')).body.meta.total).toBe(1);
      expect((await as(c.customer2).get('/api/payments')).body.meta.total).toBe(0);
      expect((await as(c.manager).get('/api/payments?status=SUCCEEDED')).body.meta.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('online payments and the webhook', () => {
    const initiate = async (amountMinor = 800_000) => (await as(c.customer).post('/api/payments/online', { bookingId: b.id, amountMinor, idempotencyKey: uniq('online-key-') })).body.data;

    test('a payment REQUEST is not a payment: nothing is paid until the verified webhook says so', async () => {
      const p = await initiate();
      expect(p).toMatchObject({ status: 'PENDING', method: 'ONLINE' });
      expect(p.checkoutUrl).toContain(p.transactionReference);
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(0);
      expect((await as(c.customer2).post('/api/payments/online', { bookingId: b.id, amountMinor: 100, idempotencyKey: uniq('theft-key-') })).status).toBe(404);
    });

    test('signature is required and verified; tampered payloads are rejected', async () => {
      const p = await initiate();
      const event = { eventId: uniq('evt'), type: 'payment.succeeded', reference: p.transactionReference, amountMinor: p.amountMinor };
      expect((await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send(JSON.stringify(event))).status).toBe(401);
      expect((await webhook(event, 'a'.repeat(64))).status).toBe(401);
      const raw = JSON.stringify(event);
      const tampered = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-signature', sign(raw)).send(raw.replace(String(p.amountMinor), '1'));
      expect(tampered.status).toBe(401);
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(0);
      expect(await PaymentWebhookEvent.countDocuments({ providerEventId: event.eventId })).toBe(0);
    });

    test('success is applied exactly once, even with duplicate and concurrent deliveries', async () => {
      const p = await initiate();
      const event = { eventId: uniq('evt'), type: 'payment.succeeded', reference: p.transactionReference, amountMinor: p.amountMinor };
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => webhook(event)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.data.outcome === 'applied')).toHaveLength(1);
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(800_000);
      // the provider sends a second, different event for the same payment: still applied once
      const second = await webhook({ ...event, eventId: uniq('evt') });
      expect(second.body.data.outcome).toBe('ignored');
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(800_000);
      expect((await Payment.findById(p.id)).status).toBe('SUCCEEDED');
    });

    test('failures, wrong amounts and unknown references never move money; a late "failed" cannot undo a success', async () => {
      const p = await initiate();
      expect((await webhook({ eventId: uniq('evt'), type: 'payment.succeeded', reference: p.transactionReference, amountMinor: 1 })).body.data.outcome).toBe('amount-mismatch');
      expect((await webhook({ eventId: uniq('evt'), type: 'payment.succeeded', reference: 'mock_unknown', amountMinor: 5 })).body.data.outcome).toBe('unknown-payment');
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(0);
      expect((await webhook({ eventId: uniq('evt'), type: 'payment.failed', reference: p.transactionReference, reason: 'card declined' })).body.data.outcome).toBe('failed');
      expect((await Payment.findById(p.id)).status).toBe('FAILED');
      const p2 = await initiate(300_000);
      await webhook({ eventId: uniq('evt'), type: 'payment.succeeded', reference: p2.transactionReference, amountMinor: 300_000 });
      expect((await webhook({ eventId: uniq('evt'), type: 'payment.failed', reference: p2.transactionReference })).body.data.outcome).toBe('ignored');
      expect((await Payment.findById(p2.id)).status).toBe('SUCCEEDED');
      expect((await BillingAccount.findById(acct)).paidMinor).toBe(300_000);
    });

    test('online payment can be the deposit that confirms a held booking', async () => {
      await as(c.admin).patch('/api/settings', { depositBps: 2000 });
      const { rooms: r2 } = await makeRooms(c.admin, 1);
      const held = (await as(c.customer).post('/api/bookings', { rooms: [r2[0].id], checkInDate: await inDays(15), checkOutDate: await inDays(16), adults: 1 })).body.data;
      await as(c.admin).patch('/api/settings', { depositBps: 0 });
      expect(held.status).toBe('PENDING');
      const p = (await as(c.customer).post('/api/payments/online', { bookingId: held.id, amountMinor: held.priceSnapshot.depositRequiredMinor, idempotencyKey: uniq('dep-key-') })).body.data;
      await webhook({ eventId: uniq('evt'), type: 'payment.succeeded', reference: p.transactionReference, amountMinor: p.amountMinor });
      expect((await as(c.customer).get(`/api/bookings/${held.id}`)).body.data.status).toBe('CONFIRMED');
    });
  });
});
