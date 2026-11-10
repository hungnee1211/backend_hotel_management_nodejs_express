import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const date = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };
const schema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 2000 },
  capacity: { type: Number, required: true, min: 1, max: 20 },
  bedConfiguration: { type: String, trim: true, maxlength: 120 },
  amenities: { type: [String], default: [] },
  images: { type: [String], default: [] },
  basePriceMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
  // Seasonal prices: a night whose date key falls in [from, to] (inclusive) uses priceMinor instead of the base price.
  rates: { type: [new Schema({ name: String, from: { ...date, required: true }, to: { ...date, required: true }, priceMinor: { type: Number, required: true, min: 0, validate: Number.isInteger } }, { _id: true })], default: [] },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
schema.index({ name: 1 }, { unique: true });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('RoomType', schema);
