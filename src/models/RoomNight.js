import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { NIGHT_STATE } from '../constants/index.js';
const { Schema } = mongoose;
/** The inventory ledger: ONE row per room per night. The unique index is what makes double-booking impossible. */
const schema = new Schema({
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // hotel-local night key
  state: { type: String, enum: Object.values(NIGHT_STATE), required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
  holdExpiresAt: { type: Date, default: null }, // only for HELD rows
  blockRef: { type: Schema.Types.ObjectId, default: null }, // maintenance request that blocks this night
  reason: String,
}, { timestamps: true });
schema.index({ roomId: 1, date: 1 }, { unique: true });
schema.index({ bookingId: 1 });
schema.index({ date: 1, state: 1 });
schema.index({ blockRef: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('RoomNight', schema);
