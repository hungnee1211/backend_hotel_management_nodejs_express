import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  currency: { type: String, required: true },
  status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  // Cached running totals, updated in the same transaction as the record that changes them.
  totalChargesMinor: { type: Number, default: 0 }, // sum of POSTED charges (pre-tax)
  paidMinor: { type: Number, default: 0 }, // succeeded payments minus refunds
  openedAt: { type: Date, default: Date.now }, closedAt: Date,
}, { timestamps: true });
schema.index({ bookingId: 1 }, { unique: true });
schema.index({ customerId: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('BillingAccount', schema);
