import mongoose from 'mongoose';
import BillingAccount from '../../models/BillingAccount.js';
import BillingCharge from '../../models/BillingCharge.js';
import Booking from '../../models/Booking.js';
import Guest from '../../models/Guest.js';
import Invoice from '../../models/Invoice.js';
import InvoiceAdjustment from '../../models/InvoiceAdjustment.js';
import User from '../../models/User.js';
import { ROLES } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { calculateInvoice, deriveStatus } from '../billing/invoice.calculator.js';
import { billingService } from '../billing/billing.service.js';
import { counterService } from '../counters/counter.service.js';
import { settingsService } from '../settings/settings.service.js';
import { buildInvoicePdf } from './invoice.pdf.js';

const same = (a, b) => String(a) === String(b);
const owed = (i) => i.grandTotalMinor + (i.adjustmentsTotalMinor ?? 0);
const money = (i) => ({ outstandingMinor: owed(i) - i.paidMinor });

const snapshotFor = async (account, bookingId) => {
  if (account.customerId) {
    const u = await User.findById(account.customerId).select('fullName email phone').lean();
    if (u) return { fullName: u.fullName, email: u.email, phone: u.phone };
  }
  const booking = await Booking.findById(bookingId).select('guestIds').lean();
  const g = booking?.guestIds?.[0] && (await Guest.findById(booking.guestIds[0]).select('fullName email phone').lean());
  return g ? { fullName: g.fullName, email: g.email, phone: g.phone } : { fullName: 'Guest' };
};

/** Collects the account's open charges and runs the pure calculator against the rules in force NOW. */
const computeFor = async (account, { session, at = new Date() } = {}) => {
  const charges = await BillingCharge.find({ billingAccountId: account._id, status: 'POSTED', invoiceId: null }).sort({ occurredAt: 1, _id: 1 }).session(session ?? null).lean();
  const settings = await settingsService.get({ session });
  const taxRules = await settingsService.activeTaxRules(at);
  return { charges, settings, calc: calculateInvoice({ charges, taxRules, serviceChargeBps: settings.serviceChargeBps }) };
};

const scopeFilter = (caller) => (caller.permissions.has(P.BILLING_READ_ALL) ? {} : { customerId: caller.user._id });
const loadForCaller = async (caller, id) => {
  const inv = mongoose.isValidObjectId(id) ? await Invoice.findOne({ _id: id, ...scopeFilter(caller) }) : null;
  if (!inv || (!caller.permissions.has(P.BILLING_READ_ALL) && !caller.permissions.has(P.INVOICE_READ_OWN))) throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');
  if (!caller.permissions.has(P.BILLING_READ_ALL) && inv.status === 'DRAFT') throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND'); // guests only see issued invoices
  return inv;
};

export const invoiceService = {
  prepareNumber: () => counterService.formatted('invoice', 'INV', 6), // outside any transaction: gaps are fine, duplicates are not

  /** Creates or refreshes the DRAFT preview. Issued invoices are never regenerated: use adjustments. */
  async generate(caller, accountId, ctx) {
    const account = await billingService.findById(accountId);
    if (!account) throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
    const existing = await Invoice.findOne({ billingAccountId: account._id, isActive: true });
    if (existing && existing.status !== 'DRAFT') throw ApiError.conflict('An invoice has already been issued for this stay', 'INVOICE_EXISTS');
    const { calc } = await computeFor(account);
    const data = { ...calc, billingAccountId: account._id, bookingId: account.bookingId, customerId: account.customerId, currency: account.currency, customerSnapshot: await snapshotFor(account, account.bookingId), status: 'DRAFT', paidMinor: account.paidMinor, createdBy: caller.user._id };
    data.outstandingMinor = data.grandTotalMinor - data.paidMinor;
    let invoice;
    try {
      invoice = existing ? await Invoice.findByIdAndUpdate(existing._id, { $set: data }, { new: true }) : await Invoice.create(data);
    } catch (err) {
      if (err.code !== 11000) throw err; // a concurrent generate won the race: refresh that one instead
      invoice = await Invoice.findOneAndUpdate({ billingAccountId: account._id, isActive: true, status: 'DRAFT' }, { $set: data }, { new: true });
    }
    await auditService.log(caller.user, ctx, 'INVOICE_DRAFT_GENERATED', 'Invoice', invoice._id, { after: { grandTotalMinor: invoice.grandTotalMinor } });
    return invoice.toJSON();
  },

  /**
   * Final calculation + lock. Runs INSIDE the caller's transaction (check-out) or its own (manual issue).
   * Idempotent: if the stay already has an issued invoice, that invoice is returned unchanged.
   */
  async issueForAccount(accountId, actorId, { session, invoiceNumber }) {
    const account = await BillingAccount.findById(accountId).session(session);
    const current = await Invoice.findOne({ billingAccountId: accountId, isActive: true }).session(session);
    if (current && current.status !== 'DRAFT') return current;
    const now = new Date();
    const { charges, settings, calc } = await computeFor(account, { session, at: now });
    const dueAt = new Date(now.getTime() + settings.billing.invoiceDueDays * 86_400_000);
    const base = { ...calc, billingAccountId: account._id, bookingId: account.bookingId, customerId: account.customerId, currency: account.currency, customerSnapshot: await snapshotFor(account, account.bookingId), paidMinor: account.paidMinor, issuedAt: now, dueAt, issuedBy: actorId, isActive: true };
    base.outstandingMinor = base.grandTotalMinor - base.paidMinor;
    base.status = deriveStatus({ ...base, status: 'ISSUED' }, now);
    let invoice;
    if (current) invoice = await Invoice.findByIdAndUpdate(current._id, { $set: { ...base, invoiceNumber }, }, { new: true, session });
    else invoice = (await Invoice.create([{ ...base, invoiceNumber, createdBy: actorId }], { session }))[0];
    await BillingCharge.updateMany({ _id: { $in: charges.map((c) => c._id) } }, { $set: { invoiceId: invoice._id } }, { session });
    return invoice;
  },

  async issue(caller, invoiceId, ctx) {
    const inv = await Invoice.findById(invoiceId);
    if (!inv || inv.status === 'VOID') throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');
    if (inv.status !== 'DRAFT') throw ApiError.conflict('Invoice already issued', 'INVOICE_ALREADY_ISSUED');
    const invoiceNumber = inv.invoiceNumber ?? (await this.prepareNumber());
    const issued = await withTransaction((session) => this.issueForAccount(inv.billingAccountId, caller.user._id, { session, invoiceNumber }));
    await auditService.log(caller.user, ctx, 'INVOICE_ISSUED', 'Invoice', issued._id, { after: { invoiceNumber: issued.invoiceNumber, grandTotalMinor: issued.grandTotalMinor } });
    return issued.toJSON();
  },

  /** Keeps invoice.paid/outstanding/status in step with the account's paid total (same transaction as the payment). */
  async syncPaid(accountId, { session }) {
    const account = await BillingAccount.findById(accountId).session(session);
    const inv = await Invoice.findOne({ billingAccountId: accountId, isActive: true }).session(session);
    if (!inv) return null;
    inv.paidMinor = account.paidMinor;
    inv.outstandingMinor = money(inv).outstandingMinor;
    if (inv.status !== 'DRAFT') inv.status = deriveStatus(inv.toObject());
    await inv.save({ session });
    return inv;
  },

  async get(caller, id) {
    const inv = await loadForCaller(caller, id);
    const adjustments = await InvoiceAdjustment.find({ invoiceId: inv._id }).sort({ createdAt: 1 });
    return { ...inv.toJSON(), adjustments: adjustments.map((a) => a.toJSON()) };
  },

  async list(caller, q) {
    const filter = { ...scopeFilter(caller) };
    if (!caller.permissions.has(P.BILLING_READ_ALL)) filter.status = { $ne: 'DRAFT' };
    if (!caller.permissions.has(P.BILLING_READ_ALL) && !caller.permissions.has(P.INVOICE_READ_OWN)) throw ApiError.forbidden();
    for (const k of ['status', 'bookingId', 'customerId', 'invoiceNumber']) if (q[k]) filter[k] = q[k];
    if (q.from || q.to) filter.issuedAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: q.to }) };
    const paging = parsePagination(q, { allowedSort: ['issuedAt', 'createdAt', 'grandTotalMinor'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([Invoice.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Invoice.countDocuments(filter)]);
    return { items: items.map((i) => i.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  /** Post-issue corrections. Original figures are never overwritten; a signed adjustment record is added. */
  async adjust(caller, invoiceId, { adjustmentType, amountMinor, reason }, ctx) {
    const settings = await settingsService.get();
    if (caller.user.role !== ROLES.ADMIN && amountMinor > settings.billing.managerApprovalLimitMinor) {
      throw ApiError.forbidden('This adjustment exceeds your approval limit; an Admin must approve it', 'APPROVAL_LIMIT_EXCEEDED');
    }
    const adjustment = await withTransaction(async (session) => {
      const inv = await Invoice.findById(invoiceId).session(session);
      if (!inv || !inv.isActive) throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');
      if (inv.status === 'DRAFT') throw ApiError.conflict('Draft invoices are regenerated, not adjusted', 'INVOICE_NOT_ISSUED');
      const signed = adjustmentType === 'CREDIT' ? -amountMinor : amountMinor;
      if (owed(inv) + signed < 0) throw ApiError.unprocessable('A credit cannot exceed the amount owed on the invoice', [{ field: 'body.amountMinor', message: 'too large' }], 'CREDIT_EXCEEDS_TOTAL');
      const rec = (await InvoiceAdjustment.create([{ invoiceId, adjustmentType, amountMinor, reason, createdBy: caller.user._id, approvedBy: caller.user._id }], { session }))[0];
      inv.adjustmentsTotalMinor = (inv.adjustmentsTotalMinor ?? 0) + signed;
      inv.outstandingMinor = money(inv).outstandingMinor;
      inv.status = deriveStatus(inv.toObject());
      await inv.save({ session });
      return rec;
    });
    await auditService.log(caller.user, ctx, 'INVOICE_ADJUSTED', 'Invoice', invoiceId, { after: { adjustmentType, amountMinor, reason } });
    return adjustment.toJSON();
  },

  /** Admin only, and only while nothing has been paid. Releases the charges so a corrected invoice can be generated. */
  async voidInvoice(caller, id, reason, ctx) {
    await withTransaction(async (session) => {
      const inv = await Invoice.findById(id).session(session);
      if (!inv || inv.status === 'VOID') throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');
      if (inv.paidMinor > 0) throw ApiError.conflict('Refund the payments before voiding this invoice', 'INVOICE_HAS_PAYMENTS');
      inv.status = 'VOID'; inv.isActive = false; inv.voidedAt = new Date();
      await inv.save({ session });
      await BillingCharge.updateMany({ invoiceId: inv._id }, { $set: { invoiceId: null } }, { session });
    });
    await auditService.log(caller.user, ctx, 'INVOICE_VOIDED', 'Invoice', id, { after: { reason } });
  },

  async pdf(caller, id) {
    const inv = await loadForCaller(caller, id);
    return { buffer: await buildInvoicePdf(inv.toJSON()), filename: `${inv.invoiceNumber ?? 'draft'}.pdf` };
  },

  /** Job: flips unpaid invoices past their due date to OVERDUE. */
  async markOverdue(now = new Date()) {
    const r = await Invoice.updateMany({ isActive: true, status: { $in: ['ISSUED', 'PARTIALLY_PAID'] }, dueAt: { $lt: now } }, { $set: { status: 'OVERDUE' } });
    return r.modifiedCount;
  },
};
