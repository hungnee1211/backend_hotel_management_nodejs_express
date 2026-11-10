import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../../config/environment.js';
import BillingAccount from '../../models/BillingAccount.js';
import Invoice from '../../models/Invoice.js';
import Payment from '../../models/Payment.js';
import PaymentWebhookEvent from '../../models/PaymentWebhookEvent.js';
import Refund from '../../models/Refund.js';
import { ROLES } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { generateOpaqueToken, safeEqual } from '../../utils/crypto.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { bookingService } from '../bookings/booking.service.js';
import { billingService } from '../billing/billing.service.js';
import { invoiceService } from '../invoices/invoice.service.js';
import { settingsService } from '../settings/settings.service.js';

const same = (a, b) => String(a) === String(b);
const isDup = (err, field) => err?.code === 11000 && (!field || JSON.stringify(err.keyPattern ?? {}).includes(field));

/** A payment cannot exceed what is still owed: the issued invoice's outstanding, or (no invoice yet) the charges so far. */
const assertNotOverpaying = async (account, amountMinor, { session } = {}) => {
  const inv = await Invoice.findOne({ billingAccountId: account._id, isActive: true, status: { $nin: ['DRAFT', 'VOID'] } }).session(session ?? null);
  const room = inv ? inv.grandTotalMinor + (inv.adjustmentsTotalMinor ?? 0) - inv.paidMinor : account.totalChargesMinor - account.paidMinor;
  if (amountMinor > room) throw ApiError.unprocessable(`Amount exceeds the ${inv ? 'outstanding balance' : 'charges recorded so far'} (${Math.max(room, 0)})`, [{ field: 'body.amountMinor', message: 'overpayment' }], 'OVERPAYMENT');
};

/**
 * Marks a PENDING/PROCESSING payment SUCCEEDED and applies it to the account, invoice and booking, all in the
 * caller's transaction. The conditional update makes this idempotent: a payment can only succeed once.
 */
const applySucceeded = async (paymentId, { session }) => {
  const payment = await Payment.findOneAndUpdate({ _id: paymentId, status: { $in: ['PENDING', 'PROCESSING'] } }, { $set: { status: 'SUCCEEDED', paidAt: new Date() } }, { new: true, session });
  if (!payment) return null;
  await BillingAccount.updateOne({ _id: payment.billingAccountId }, { $inc: { paidMinor: payment.amountMinor } }, { session });
  const invoice = await invoiceService.syncPaid(payment.billingAccountId, { session });
  if (invoice && !payment.invoiceId && invoice.status !== 'DRAFT') await Payment.updateOne({ _id: payment._id }, { $set: { invoiceId: invoice._id } }, { session });
  await bookingService.onPaymentApplied(payment.bookingId, { session });
  return payment;
};

const resolveAccount = async (accountId, bookingId) => {
  const account = accountId ? await billingService.findById(accountId) : await billingService.getByBooking(bookingId);
  if (!account) throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
  if (account.status === 'CLOSED') throw ApiError.conflict('The billing account is closed', 'ACCOUNT_CLOSED');
  return account;
};

export const paymentService = {
  /** Records money received as part of another transaction (e.g. cash taken on delivery of a room-service order). */
  async recordInSession({ billingAccountId, bookingId, amountMinor, method, receivedBy, idempotencyKey, currency, note }, { session }) {
    const [created] = await Payment.create([{ billingAccountId, bookingId, amountMinor, currency, method, status: 'PENDING', provider: 'manual', idempotencyKey, receivedBy, createdBy: receivedBy, note }], { session });
    return applySucceeded(created._id, { session });
  },

  /** Staff-recorded money received in person or confirmed transfers (cash / card terminal / bank transfer). */
  async record(caller, { accountId, bookingId, amountMinor, method, idempotencyKey, transactionReference, note }, ctx) {
    const existing = await Payment.findOne({ idempotencyKey });
    if (existing) return { payment: existing.toJSON(), replayed: true };
    const account = await resolveAccount(accountId, bookingId);
    await assertNotOverpaying(account, amountMinor);
    try {
      const payment = await withTransaction(async (session) => {
        const [created] = await Payment.create([{ billingAccountId: account._id, bookingId: account.bookingId, amountMinor, currency: account.currency, method, status: 'PENDING', provider: 'manual', transactionReference, idempotencyKey, receivedBy: caller.user._id, createdBy: caller.user._id, note }], { session });
        return applySucceeded(created._id, { session });
      });
      await auditService.log(caller.user, ctx, 'PAYMENT_RECORDED', 'Payment', payment._id, { after: { amountMinor, method } });
      return { payment: payment.toJSON(), replayed: false };
    } catch (err) {
      if (isDup(err, 'idempotencyKey')) return { payment: (await Payment.findOne({ idempotencyKey })).toJSON(), replayed: true };
      throw err;
    }
  },

  /** Customer starts an online payment. It stays PENDING until the provider's webhook confirms it. */
  async initiateOnline(caller, { bookingId, amountMinor, idempotencyKey }) {
    const existing = await Payment.findOne({ idempotencyKey });
    if (existing) return { payment: existing.toJSON(), replayed: true };
    const account = await resolveAccount(null, bookingId);
    if (!account.customerId || !same(account.customerId, caller.user._id)) throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
    await assertNotOverpaying(account, amountMinor);
    try {
      const payment = await Payment.create({ billingAccountId: account._id, bookingId: account.bookingId, amountMinor, currency: account.currency, method: 'ONLINE', status: 'PENDING', provider: 'mock', transactionReference: `mock_${generateOpaqueToken(12)}`, idempotencyKey, createdBy: caller.user._id });
      return { payment: { ...payment.toJSON(), checkoutUrl: `https://pay.example.test/checkout/${payment.transactionReference}` }, replayed: false };
    } catch (err) {
      if (isDup(err, 'idempotencyKey')) return { payment: (await Payment.findOne({ idempotencyKey })).toJSON(), replayed: true };
      throw err;
    }
  },

  /**
   * Provider callback. Verified (HMAC over the raw body), de-duplicated (unique event id) and forward-only
   * (a SUCCEEDED payment can never go back to FAILED), so redelivery or reordering is harmless.
   */
  async handleWebhook(rawBody, signature) {
    if (!env.PAYMENT_WEBHOOK_SECRET) throw new ApiError(503, 'Webhook is not configured', 'WEBHOOK_NOT_CONFIGURED');
    const expected = crypto.createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(rawBody ?? '').digest('hex');
    if (!signature || !safeEqual(expected, signature)) throw ApiError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
    const event = JSON.parse(rawBody.toString('utf8'));
    try {
      await PaymentWebhookEvent.create({ providerEventId: event.eventId, provider: 'mock', payload: event });
    } catch (err) {
      if (isDup(err)) return { duplicate: true };
      throw err;
    }
    const payment = await Payment.findOne({ provider: 'mock', transactionReference: event.reference });
    let outcome = 'ignored';
    if (!payment) outcome = 'unknown-payment';
    else if (event.type === 'payment.succeeded') {
      if (event.amountMinor !== payment.amountMinor) outcome = 'amount-mismatch';
      else { const applied = await withTransaction((session) => applySucceeded(payment._id, { session })); outcome = applied ? 'applied' : 'ignored'; }
    } else if (event.type === 'payment.failed') {
      const r = await Payment.updateOne({ _id: payment._id, status: { $in: ['PENDING', 'PROCESSING'] } }, { $set: { status: 'FAILED', failureReason: event.reason ?? 'failed' } });
      outcome = r.modifiedCount ? 'failed' : 'ignored';
    }
    await PaymentWebhookEvent.updateOne({ providerEventId: event.eventId }, { $set: { processedAt: new Date(), outcome } });
    return { duplicate: false, outcome };
  },

  async refund(caller, paymentId, { amountMinor, reason, idempotencyKey }, ctx) {
    const dup = idempotencyKey && (await Refund.findOne({ idempotencyKey }));
    if (dup) return { refund: dup.toJSON(), replayed: true };
    const settings = await settingsService.get();
    if (caller.user.role !== ROLES.ADMIN && amountMinor > settings.billing.managerApprovalLimitMinor) throw ApiError.forbidden('This refund exceeds your approval limit; an Admin must approve it', 'APPROVAL_LIMIT_EXCEEDED');
    try {
      const refund = await withTransaction(async (session) => {
        const payment = await Payment.findById(paymentId).session(session);
        if (!payment || !['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw ApiError.conflict('Only succeeded payments can be refunded', 'PAYMENT_NOT_REFUNDABLE');
        const refundable = payment.amountMinor - payment.refundedMinor;
        if (amountMinor > refundable) throw ApiError.unprocessable(`At most ${refundable} can still be refunded`, [{ field: 'body.amountMinor', message: 'exceeds refundable amount' }], 'REFUND_EXCEEDS_PAYMENT');
        const [r] = await Refund.create([{ paymentId, billingAccountId: payment.billingAccountId, amountMinor, reason, idempotencyKey, createdBy: caller.user._id }], { session });
        payment.refundedMinor += amountMinor;
        payment.status = payment.refundedMinor === payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await payment.save({ session });
        await BillingAccount.updateOne({ _id: payment.billingAccountId }, { $inc: { paidMinor: -amountMinor } }, { session });
        const inv = await invoiceService.syncPaid(payment.billingAccountId, { session });
        if (inv && inv.status === 'PAID' && inv.paidMinor === 0 && inv.grandTotalMinor + (inv.adjustmentsTotalMinor ?? 0) <= 0) { inv.status = 'REFUNDED'; await inv.save({ session }); }
        return r;
      });
      await auditService.log(caller.user, ctx, 'PAYMENT_REFUNDED', 'Payment', paymentId, { after: { amountMinor, reason } });
      return { refund: refund.toJSON(), replayed: false };
    } catch (err) {
      if (idempotencyKey && isDup(err, 'idempotencyKey')) return { refund: (await Refund.findOne({ idempotencyKey })).toJSON(), replayed: true };
      throw err;
    }
  },

  async list(caller, q) {
    const filter = {};
    if (!caller.permissions.has(P.BILLING_READ_ALL)) filter.billingAccountId = { $in: await BillingAccount.find({ customerId: caller.user._id }).distinct('_id') };
    for (const k of ['status', 'method', 'bookingId']) if (q[k]) filter[k] = q[k];
    const paging = parsePagination(q, { allowedSort: ['createdAt', 'paidAt', 'amountMinor'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([Payment.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Payment.countDocuments(filter)]);
    return { items: items.map((p) => p.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id) {
    const p = mongoose.isValidObjectId(id) ? await Payment.findById(id) : null;
    if (!p) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    if (!caller.permissions.has(P.BILLING_READ_ALL)) {
      const acct = await BillingAccount.findById(p.billingAccountId);
      if (!acct?.customerId || !same(acct.customerId, caller.user._id)) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    }
    return { ...p.toJSON(), refunds: (await Refund.find({ paymentId: p._id })).map((r) => r.toJSON()) };
  },
};
