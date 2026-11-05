import mongoose from 'mongoose';
import { TAXABLE_CATEGORIES } from '../constants/index.js';

const { Schema } = mongoose;

/**
 * Configurable tax / service-charge rule. Rates are integer basis points (10% = 1000).
 * Rules are versioned by effectiveFrom/effectiveTo so historical invoices keep their original rate.
 */
const taxRuleSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true }, // e.g. VAT
    name: { type: String, required: true, trim: true },
    rateBps: { type: Number, required: true, min: 0, max: 100000, validate: { validator: Number.isInteger, message: 'rateBps must be an integer' } },
    appliesTo: { type: [{ type: String, enum: TAXABLE_CATEGORIES }], validate: (v) => v.length > 0 },
    isServiceCharge: { type: Boolean, default: false },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

taxRuleSchema.index({ code: 1, effectiveFrom: 1 }, { unique: true });
taxRuleSchema.index({ isActive: 1, effectiveFrom: 1, effectiveTo: 1 });

export default mongoose.model('TaxRule', taxRuleSchema);
