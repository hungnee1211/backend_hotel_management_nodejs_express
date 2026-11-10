import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true }, title: { type: String, required: true }, body: String,
  refType: String, refId: Schema.Types.ObjectId, dedupeKey: String, readAt: Date,
}, { timestamps: true });
schema.index({ userId: 1, readAt: 1, createdAt: -1 });
schema.index({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Notification', schema);
