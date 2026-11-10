import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { ATTENDANCE_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  staffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true },
  date: { type: String, required: true },
  checkInAt: Date, checkOutAt: Date,
  status: { type: String, enum: Object.values(ATTENDANCE_STATUS), default: ATTENDANCE_STATUS.OPEN },
  lateMinutes: { type: Number, default: 0 }, earlyDepartureMinutes: { type: Number, default: 0 }, workedMinutes: { type: Number, default: 0 },
  note: String, approvedBy: Schema.Types.ObjectId,
  correction: { requestedCheckInAt: Date, requestedCheckOutAt: Date, reason: String, status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'] }, requestedAt: Date, decidedBy: Schema.Types.ObjectId, decidedAt: Date },
}, { timestamps: true });
schema.index({ staffId: 1, shiftId: 1 }, { unique: true }); // no duplicate check-in for one shift
schema.index({ staffId: 1, date: 1 });
schema.index({ date: 1, status: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Attendance', schema);
