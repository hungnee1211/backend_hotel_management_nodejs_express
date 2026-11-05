import mongoose from 'mongoose';
import { GUEST_ID_TYPES } from '../constants/index.js';
import { PHONE_REGEX } from '../utils/identifier.js';

const { Schema } = mongoose;

const guestSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'] },
    phone: { type: String, trim: true, match: [PHONE_REGEX, 'Invalid phone number'] },
    nationality: { type: String, trim: true, maxlength: 60 },
    identification: {
      type: { type: String, enum: Object.values(GUEST_ID_TYPES) },
      numberEncrypted: { type: String, select: false }, // AES-256-GCM, never returned by default
      numberHash: { type: String, select: false }, // blind index for exact-match lookup
      last4: { type: String }, // the only part ever shown by default
    },
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      country: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    // Optional: the customer account this guest is (walk-ins have none).
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.deletedAt;
        delete ret.identification; // the service builds the masked/revealed view explicitly
        return ret;
      },
    },
  },
);

guestSchema.index({ phone: 1 });
guestSchema.index({ email: 1 });
guestSchema.index({ userId: 1 });
guestSchema.index({ createdBy: 1 });
guestSchema.index({ 'identification.numberHash': 1 });
guestSchema.index({ fullName: 1 });

export default mongoose.model('Guest', guestSchema);
