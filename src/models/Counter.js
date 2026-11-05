import mongoose from 'mongoose';

/** Atomic named sequences (invoice numbers, booking codes, order codes). */
const counterSchema = new mongoose.Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { versionKey: false },
);

export default mongoose.model('Counter', counterSchema);
