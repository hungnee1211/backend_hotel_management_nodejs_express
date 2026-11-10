import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { HOUSEKEEPING_STATUS, ROOM_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  roomNumber: { type: String, required: true, trim: true, maxlength: 20 },
  floor: { type: Number, required: true, min: -5, max: 200 },
  roomTypeId: { type: Schema.Types.ObjectId, ref: 'RoomType', required: true },
  // Operational flag only. Availability for DATES comes from RoomNight, never from this field.
  status: { type: String, enum: Object.values(ROOM_STATUS), default: ROOM_STATUS.AVAILABLE },
  housekeepingStatus: { type: String, enum: Object.values(HOUSEKEEPING_STATUS), default: HOUSEKEEPING_STATUS.INSPECTED },
  amenities: { type: [String], default: [] },
  notes: { type: String, trim: true, maxlength: 1000 },
  isActive: { type: Boolean, default: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ roomNumber: 1 }, { unique: true });
schema.index({ roomTypeId: 1, status: 1 });
schema.index({ floor: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Room', schema);
