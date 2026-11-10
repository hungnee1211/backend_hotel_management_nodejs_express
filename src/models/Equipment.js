import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { EQUIPMENT_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  equipmentCode: { type: String, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 }, category: String, brand: String, model: String, description: String,
  facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true },
  quantity: { type: Number, default: 1, min: 1 },
  purchaseDate: Date, purchasePriceMinor: { type: Number, min: 0, validate: Number.isInteger }, warrantyExpiration: Date,
  status: { type: String, enum: Object.values(EQUIPMENT_STATUS), default: EQUIPMENT_STATUS.ACTIVE },
  maintenanceIntervalDays: { type: Number, min: 1 }, lastMaintenanceAt: Date, nextMaintenanceAt: Date,
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ equipmentCode: 1 }, { unique: true });
schema.index({ facilityId: 1, status: 1 });
schema.index({ nextMaintenanceAt: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Equipment', schema);
