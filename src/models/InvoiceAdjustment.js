import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
  adjustmentType: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amountMinor: { type: Number, required: true, min: 1 }, // always positive; the type gives the direction
  reason: { type: String, required: true, maxlength: 500 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ invoiceId: 1, createdAt: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('InvoiceAdjustment', schema);
