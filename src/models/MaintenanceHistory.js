import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', default: null }, facilityId: Schema.Types.ObjectId, roomId: Schema.Types.ObjectId,
  maintenanceRequestId: { type: Schema.Types.ObjectId, ref: 'MaintenanceRequest', required: true },
  maintenanceType: String, description: String, costMinor: { type: Number, default: 0 },
  performedBy: Schema.Types.ObjectId, maintenanceDate: { type: Date, required: true }, nextMaintenanceDate: Date,
}, { timestamps: true });
schema.index({ equipmentId: 1, maintenanceDate: -1 });
schema.index({ maintenanceDate: 1 });
schema.index({ maintenanceRequestId: 1 }, { unique: true }); // one history row per completed request
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('MaintenanceHistory', schema);
