import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { ORDER_PAYMENT, ORDER_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  orderCode: { type: String, required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{ _id: false, menuItemId: Schema.Types.ObjectId, name: String, categoryName: String, priceMinor: Number, quantity: Number, note: String }], // snapshots
  subtotalMinor: { type: Number, required: true },
  paymentMethod: { type: String, enum: Object.values(ORDER_PAYMENT), required: true },
  status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING },
  assignedStaffId: Schema.Types.ObjectId, deliveryStaffId: Schema.Types.ObjectId,
  notes: { type: String, maxlength: 500 }, deliveryLocation: String, cancelReason: String,
  deliveredAt: Date,
  statusHistory: [{ _id: false, status: String, at: Date, by: Schema.Types.ObjectId }],
}, { timestamps: true });
schema.index({ orderCode: 1 }, { unique: true });
schema.index({ bookingId: 1 });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('ServiceOrder', schema);
