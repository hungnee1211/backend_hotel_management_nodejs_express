import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { BOOKING_SOURCE, BOOKING_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const roomLine = new Schema({
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: String, roomTypeId: Schema.Types.ObjectId, roomTypeName: String, capacity: Number,
  nightly: [{ _id: false, date: String, priceMinor: Number }], // price snapshot per night, frozen at booking time
  subtotalMinor: Number,
}, { _id: false });
const schema = new Schema({
  bookingCode: { type: String, required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null for walk-ins without an account
  guestIds: [{ type: Schema.Types.ObjectId, ref: 'Guest' }],
  rooms: { type: [roomLine], validate: (v) => v.length > 0 },
  checkInDate: { type: String, required: true }, checkOutDate: { type: String, required: true }, nights: Number,
  numberOfAdults: { type: Number, required: true, min: 1 }, numberOfChildren: { type: Number, default: 0, min: 0 },
  source: { type: String, enum: Object.values(BOOKING_SOURCE), default: BOOKING_SOURCE.WEBSITE },
  status: { type: String, enum: Object.values(BOOKING_STATUS), required: true },
  holdExpiresAt: { type: Date, default: null },
  priceSnapshot: { currency: String, roomTotalMinor: Number, depositRequiredMinor: { type: Number, default: 0 } },
  specialRequests: { type: String, maxlength: 1000 },
  cancellation: { at: Date, by: Schema.Types.ObjectId, reason: String, penaltyMinor: Number, penaltyNights: Number, freeCancellation: Boolean },
  actualCheckInAt: Date, checkedInBy: Schema.Types.ObjectId,
  actualCheckOutAt: Date, checkedOutBy: Schema.Types.ObjectId,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  statusHistory: [{ _id: false, status: String, at: Date, by: Schema.Types.ObjectId, note: String }],
}, { timestamps: true });
schema.index({ bookingCode: 1 }, { unique: true });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, checkInDate: 1 });
schema.index({ status: 1, holdExpiresAt: 1 });
schema.index({ 'rooms.roomId': 1, status: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Booking', schema);
