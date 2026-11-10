import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { SERVICE_REQUEST_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  requestCode: { type: String, required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hotelServiceId: { type: Schema.Types.ObjectId, ref: 'HotelService', required: true },
  serviceSnapshot: { name: String, category: String, pricingType: String, unitPriceMinor: Number }, // frozen at request time
  quantity: { type: Number, required: true, min: 1 }, totalMinor: { type: Number, required: true },
  scheduledAt: Date, notes: { type: String, maxlength: 500 }, cancelReason: String,
  status: { type: String, enum: Object.values(SERVICE_REQUEST_STATUS), default: SERVICE_REQUEST_STATUS.REQUESTED },
  assignedStaffId: Schema.Types.ObjectId, completedAt: Date,
  statusHistory: [{ _id: false, status: String, at: Date, by: Schema.Types.ObjectId }],
}, { timestamps: true });
schema.index({ requestCode: 1 }, { unique: true });
schema.index({ bookingId: 1 });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('ServiceRequest', schema);
