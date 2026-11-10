import mongoose from 'mongoose';
import BillingAccount from '../../models/BillingAccount.js';
import BillingCharge from '../../models/BillingCharge.js';
import Invoice from '../../models/Invoice.js';
import { CHARGE_CATEGORIES as C, CHARGE_STATUS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { mulInt } from '../../utils/money.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { settingsService } from '../settings/settings.service.js';

const same = (a, b) => String(a) === String(b);

export const billingService = {
  async openAccount({ bookingId, customerId, currency }, { session }) {
    return (await BillingAccount.create([{ bookingId, customerId, currency }], { session }))[0];
  },

  /**
   * Posts ONE charge for ONE source transaction, idempotently. The unique index on
   * (sourceType, sourceId, sourceKey) plus an upsert means a retried request, a double click or a
   * replayed job can never bill the same thing twice; the second call just returns the first charge.
   * Returns { charge, created }.
   */
  async postCharge({ billingAccountId, bookingId, sourceType, sourceId, sourceKey, category, description, quantity = 1, unitPriceMinor, occurredAt = new Date(), createdBy = null }, { session }) {
    const account = await BillingAccount.findById(billingAccountId).session(session ?? null);
    if (!account) throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
    if (account.status !== 'OPEN') throw ApiError.conflict('The billing account is closed; use an invoice adjustment', 'ACCOUNT_CLOSED');
    // Once an invoice is issued the bill is final; later corrections go through invoice adjustments.
    if (await Invoice.exists({ billingAccountId, isActive: true, status: { $nin: ['DRAFT', 'VOID'] } }).session(session ?? null)) throw ApiError.conflict('An invoice has already been issued for this stay; use an invoice adjustment', 'INVOICE_ISSUED');
    const amountMinor = category === C.DISCOUNT ? -Math.abs(mulInt(unitPriceMinor, quantity)) : mulInt(unitPriceMinor, quantity);
    const res = await BillingCharge.findOneAndUpdate(
      { sourceType, sourceId, sourceKey },
      { $setOnInsert: { billingAccountId, bookingId, sourceType, sourceId, sourceKey, category, description, quantity, unitPriceMinor: category === C.DISCOUNT ? -Math.abs(unitPriceMinor) : unitPriceMinor, amountMinor, status: CHARGE_STATUS.POSTED, occurredAt, createdBy } },
      { upsert: true, new: true, includeResultMetadata: true, session, setDefaultsOnInsert: true },
    );
    const created = !res.lastErrorObject?.updatedExisting;
    if (created) await BillingAccount.updateOne({ _id: billingAccountId }, { $inc: { totalChargesMinor: amountMinor } }, { session });
    return { charge: res.value, created };
  },

  /** Voids POSTED, not-yet-invoiced charges matching `match` and keeps the account total in step. */
  async voidCharges(billingAccountId, match, reason, { session }) {
    const charges = await BillingCharge.find({ billingAccountId, status: CHARGE_STATUS.POSTED, invoiceId: null, ...match }).session(session ?? null);
    if (!charges.length) return 0;
    await BillingCharge.updateMany({ _id: { $in: charges.map((c) => c._id) } }, { $set: { status: CHARGE_STATUS.VOIDED, voidedAt: new Date(), voidReason: reason } }, { session });
    const total = charges.reduce((a, c) => a + c.amountMinor, 0);
    await BillingAccount.updateOne({ _id: billingAccountId }, { $inc: { totalChargesMinor: -total } }, { session });
    return total;
  },

  closeAccount: (billingAccountId, { session }) => BillingAccount.updateOne({ _id: billingAccountId }, { $set: { status: 'CLOSED', closedAt: new Date() } }, { session }),
  getByBooking: (bookingId, { session } = {}) => BillingAccount.findOne({ bookingId }).session(session ?? null),
  findById: (id, { session } = {}) => BillingAccount.findById(id).session(session ?? null),

  /** Own account for customers; any account for roles with BILLING_READ_ALL. 404 hides other people's accounts. */
  async getForCaller(caller, id) {
    const account = mongoose.isValidObjectId(id) ? await BillingAccount.findById(id) : null;
    if (!account) throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
    if (caller.permissions.has(P.BILLING_READ_ALL)) return account;
    if (caller.permissions.has(P.BILLING_READ_OWN) && account.customerId && same(account.customerId, caller.user._id)) return account;
    throw ApiError.notFound('Billing account not found', 'BILLING_ACCOUNT_NOT_FOUND');
  },

  async list(caller, query) {
    const filter = {};
    if (query.bookingId) filter.bookingId = query.bookingId;
    if (!caller.permissions.has(P.BILLING_READ_ALL)) filter.customerId = caller.user._id;
    const paging = parsePagination(query, { defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([BillingAccount.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), BillingAccount.countDocuments(filter)]);
    return { items: items.map((a) => a.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async listCharges(caller, accountId, query) {
    const account = await this.getForCaller(caller, accountId);
    const filter = { billingAccountId: account._id, ...(query.status ? { status: query.status } : {}), ...(query.category ? { category: query.category } : {}) };
    const paging = parsePagination(query, { defaultSort: 'occurredAt', defaultLimit: 100 });
    const [items, total] = await Promise.all([BillingCharge.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), BillingCharge.countDocuments(filter)]);
    return { items: items.map((c) => c.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  /** Authorised manual charges: surcharges (late checkout, damage...) and discounts. Not used by guests or front-desk staff. */
  async addManualCharge(caller, accountId, { category, description, quantity = 1, unitPriceMinor, reason }, ctx) {
    const account = await this.getForCaller(caller, accountId);
    const settings = await settingsService.get();
    const amount = Math.abs(mulInt(unitPriceMinor, quantity));
    if (category === C.DISCOUNT && caller.user.role !== 'ADMIN' && amount > settings.billing.managerApprovalLimitMinor) {
      throw ApiError.forbidden('This discount exceeds your approval limit; an Admin must approve it', 'APPROVAL_LIMIT_EXCEEDED');
    }
    const sourceId = new mongoose.Types.ObjectId();
    const { charge } = await this.postCharge({ billingAccountId: account._id, bookingId: account.bookingId, sourceType: 'MANUAL', sourceId, sourceKey: 'manual', category, description: reason ? `${description} (${reason})` : description, quantity, unitPriceMinor, createdBy: caller.user._id }, {});
    await auditService.log(caller.user, ctx, 'CHARGE_ADDED_MANUALLY', 'BillingCharge', charge._id, { after: charge });
    return charge.toJSON();
  },

  /** Consistency check: cached account totals vs. the ledger. Used by tests and the reconcile job. */
  async reconcile(accountId) {
    const [row] = await BillingCharge.aggregate([{ $match: { billingAccountId: new mongoose.Types.ObjectId(String(accountId)), status: CHARGE_STATUS.POSTED } }, { $group: { _id: null, total: { $sum: '$amountMinor' } } }]);
    const account = await BillingAccount.findById(accountId);
    return { cached: account.totalChargesMinor, ledger: row?.total ?? 0, consistent: account.totalChargesMinor === (row?.total ?? 0) };
  },
};
