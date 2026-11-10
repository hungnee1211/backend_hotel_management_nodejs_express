import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  categoryId: { type: Schema.Types.ObjectId, ref: 'MenuCategory', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 }, description: { type: String, maxlength: 1000 },
  priceMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
  images: { type: [String], default: [] }, preparationMinutes: { type: Number, default: 15, min: 0 },
  availability: { type: Boolean, default: true }, // e.g. sold out today
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
schema.index({ categoryId: 1, status: 1 });
schema.index({ name: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('MenuItem', schema);
