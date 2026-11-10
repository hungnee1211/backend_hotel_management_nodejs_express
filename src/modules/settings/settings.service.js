import { env } from '../../config/environment.js';
import Settings from '../../models/Settings.js';
import TaxRule from '../../models/TaxRule.js';
import { ApiError } from '../../utils/ApiError.js';
import { auditService } from '../audit-logs/audit.service.js';

const defaults = () => ({ timezone: env.HOTEL_TIMEZONE, currency: env.HOTEL_CURRENCY });
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));

export const settingsService = {
  /** Hotel-wide configuration (created from environment defaults on first use). */
  get: (opts = {}) => Settings.findOneAndUpdate({ key: 'hotel' }, { $setOnInsert: { key: 'hotel', ...defaults() } }, { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true, session: opts.session }).lean(),

  async update(actor, patch, ctx) {
    const before = await this.get();
    const $set = Object.fromEntries(flatten(patch));
    const after = await Settings.findOneAndUpdate({ key: 'hotel' }, { $set }, { new: true, runValidators: true }).lean();
    await auditService.log(actor, ctx, 'SETTINGS_UPDATED', 'Settings', after._id, { before, after });
    return after;
  },

  // ---- tax rules (rates in basis points: 10% = 1000) ----
  listTaxRules: () => TaxRule.find().sort({ code: 1, effectiveFrom: -1 }).lean(),
  /** Rules in force at `at`: active, started, not yet ended. */
  activeTaxRules: (at = new Date()) => TaxRule.find({ isActive: true, effectiveFrom: { $lte: at }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] }).lean(),
  async createTaxRule(actor, data, ctx) {
    const rule = await TaxRule.create(data);
    await auditService.log(actor, ctx, 'TAX_RULE_CREATED', 'TaxRule', rule._id, { after: rule });
    return rule.toJSON();
  },
  async updateTaxRule(actor, id, patch, ctx) {
    const before = await TaxRule.findById(id).lean();
    if (!before) throw ApiError.notFound('Tax rule not found');
    // Rates never change retroactively: to change a rate, end the old rule and add a new one with a later effectiveFrom.
    if (patch.rateBps !== undefined && patch.rateBps !== before.rateBps) throw ApiError.badRequest('Create a new rule to change a rate; existing rates are history', 'TAX_RATE_IMMUTABLE');
    const after = await TaxRule.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean();
    await auditService.log(actor, ctx, 'TAX_RULE_UPDATED', 'TaxRule', id, { before, after });
    return after;
  },
};
