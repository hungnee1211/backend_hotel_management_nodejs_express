import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
  billingAccountId: { type: Schema.Types.ObjectId, ref: 'BillingAccount', required: true },
  amountMinor: { type: Number, required: true, min: 1 }, reason: { type: String, required: true, maxlength: 500 },
  idempotencyKey: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ paymentId: 1 });
schema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
schema.index({ createdAt: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Refund', schema);
