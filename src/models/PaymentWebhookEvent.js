import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  providerEventId: { type: String, required: true }, provider: String, payload: mongoose.Schema.Types.Mixed, processedAt: Date, outcome: String,
}, { timestamps: true });
schema.index({ providerEventId: 1 }, { unique: true }); // a redelivered callback can never be applied twice
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('PaymentWebhookEvent', schema);
