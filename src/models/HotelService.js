import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { PRICING_TYPE, SERVICE_CATEGORY } from '../constants/index.js';
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 }, description: { type: String, maxlength: 1000 },
  category: { type: String, enum: Object.values(SERVICE_CATEGORY), default: SERVICE_CATEGORY.OTHER },
  priceMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
  pricingType: { type: String, enum: Object.values(PRICING_TYPE), default: PRICING_TYPE.FIXED },
  availability: { type: Boolean, default: true }, status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });
schema.index({ name: 1 }, { unique: true });
schema.index({ category: 1, status: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('HotelService', schema);
