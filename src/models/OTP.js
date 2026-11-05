import mongoose from 'mongoose';
import { OTP_PURPOSES } from '../constants/index.js';

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    identifier: { type: String, required: true }, // the user's primary contact (email, else phone)
    hashedCode: { type: String, required: true, select: false }, // HMAC of the code, never the code
    purpose: { type: String, enum: Object.values(OTP_PURPOSES), required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null }, // set when verified OR superseded by a newer code
  },
  { timestamps: true },
);

otpSchema.index({ identifier: 1, purpose: 1, createdAt: -1 });
// Remove documents one hour after expiry. The hour keeps them available for the resend-rate count.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export default mongoose.model('OTP', otpSchema);
