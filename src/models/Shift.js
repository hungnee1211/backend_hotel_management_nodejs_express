import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  staffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // hotel-local date the shift STARTS on
  startTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  endTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ }, // earlier than startTime = ends next day
  department: String,
  status: { type: String, enum: ['SCHEDULED', 'CANCELLED'], default: 'SCHEDULED' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ staffId: 1, date: 1 });
schema.index({ date: 1, status: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Shift', schema);
