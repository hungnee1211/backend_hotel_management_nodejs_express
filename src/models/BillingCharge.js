import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { CHARGE_CATEGORIES, CHARGE_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  billingAccountId: { type: Schema.Types.ObjectId, ref: 'BillingAccount', required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null }, // set when an invoice is ISSUED
  sourceType: { type: String, required: true }, sourceId: { type: Schema.Types.ObjectId, required: true }, sourceKey: { type: String, required: true },
  category: { type: String, enum: Object.values(CHARGE_CATEGORIES), required: true },
  description: { type: String, required: true, maxlength: 300 },
  quantity: { type: Number, required: true, min: 1 }, unitPriceMinor: { type: Number, required: true },
  amountMinor: { type: Number, required: true }, // quantity x unit price; NEGATIVE for DISCOUNT
  status: { type: String, enum: Object.values(CHARGE_STATUS), default: CHARGE_STATUS.POSTED },
  occurredAt: { type: Date, required: true }, voidedAt: Date, voidReason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
// One source transaction can only ever be billed once.
schema.index({ sourceType: 1, sourceId: 1, sourceKey: 1 }, { unique: true });
schema.index({ billingAccountId: 1, status: 1 });
schema.index({ category: 1, occurredAt: 1 });
schema.index({ bookingId: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('BillingCharge', schema);
