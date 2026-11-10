import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { PAYMENT_METHOD, PAYMENT_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  billingAccountId: { type: Schema.Types.ObjectId, ref: 'BillingAccount', required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
  amountMinor: { type: Number, required: true, min: 1 }, currency: String,
  method: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
  status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
  provider: { type: String, default: 'manual' }, transactionReference: String, idempotencyKey: String,
  refundedMinor: { type: Number, default: 0 },
  receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  paidAt: Date, failureReason: String, note: String,
}, { timestamps: true });
schema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
schema.index({ provider: 1, transactionReference: 1 }, { unique: true, partialFilterExpression: { transactionReference: { $type: 'string' } } });
schema.index({ billingAccountId: 1, status: 1 });
schema.index({ status: 1, paidAt: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Payment', schema);
