import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { FACILITY_STATUS, FACILITY_TYPE } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  type: { type: String, enum: Object.values(FACILITY_TYPE), required: true },
  location: { type: String, maxlength: 200 }, description: { type: String, maxlength: 1000 },
  operatingHours: [{ _id: false, day: { type: Number, min: 0, max: 6 }, open: String, close: String }], // day 0 = Sunday
  status: { type: String, enum: Object.values(FACILITY_STATUS), default: FACILITY_STATUS.OPEN },
  managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // the manager responsible (their "scope")
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ name: 1 }, { unique: true });
schema.index({ managerId: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Facility', schema);
