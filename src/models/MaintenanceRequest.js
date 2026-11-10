import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { MAINT_STATUS, PRIORITY } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  requestCode: { type: String, required: true },
  type: { type: String, enum: ['CORRECTIVE', 'PREVENTIVE'], default: 'CORRECTIVE' },
  equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', default: null },
  facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', default: null },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', default: null },
  blockFrom: String, blockTo: String, // optional room out-of-service window (date keys, [from, to) like a stay)
  title: { type: String, required: true, maxlength: 200 }, description: { type: String, maxlength: 2000 },
  priority: { type: String, enum: Object.values(PRIORITY), default: PRIORITY.MEDIUM },
  status: { type: String, enum: Object.values(MAINT_STATUS), default: MAINT_STATUS.PENDING },
  reportedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }, assignedStaffId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  scheduledFor: Date, startedAt: Date, completedAt: Date,
  estimatedCostMinor: { type: Number, min: 0 }, actualCostMinor: { type: Number, min: 0 }, resolution: String,
}, { timestamps: true });
schema.index({ requestCode: 1 }, { unique: true });
schema.index({ status: 1, priority: 1 });
schema.index({ assignedStaffId: 1, status: 1 });
schema.index({ equipmentId: 1 });
schema.index({ facilityId: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('MaintenanceRequest', schema);
