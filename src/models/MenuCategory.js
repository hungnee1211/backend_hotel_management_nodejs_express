import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 }, description: { type: String, maxlength: 500 }, image: String,
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
schema.index({ name: 1 }, { unique: true });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('MenuCategory', schema);
