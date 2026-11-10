import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { HK_TASK_STATUS, PRIORITY } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
  taskType: { type: String, enum: ['CHECKOUT_CLEAN', 'DAILY_CLEAN', 'DEEP_CLEAN', 'INSPECTION'], default: 'CHECKOUT_CLEAN' },
  status: { type: String, enum: Object.values(HK_TASK_STATUS), default: HK_TASK_STATUS.PENDING },
  priority: { type: String, enum: Object.values(PRIORITY), default: PRIORITY.MEDIUM },
  assignedStaffId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: Date, completedAt: Date, inspectedBy: Schema.Types.ObjectId, inspectedAt: Date, inspectionPassed: Boolean,
  notes: { type: String, maxlength: 1000 },
  damageReports: [{ _id: false, description: String, reportedBy: Schema.Types.ObjectId, at: Date, maintenanceRequestId: Schema.Types.ObjectId }],
  createdBy: Schema.Types.ObjectId,
}, { timestamps: true });
schema.index({ roomId: 1, status: 1 });
schema.index({ assignedStaffId: 1, status: 1 });
schema.index({ status: 1, createdAt: -1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('HousekeepingTask', schema);
