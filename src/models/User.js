import mongoose from 'mongoose';
import { ROLES, USER_STATUS } from '../constants/index.js';
import { PHONE_REGEX } from '../utils/identifier.js';

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'] },
    phone: { type: String, trim: true, match: [PHONE_REGEX, 'Invalid phone number'] },
    password: { type: String, required: true, select: false }, // bcrypt hash, never plaintext
    role: { type: String, enum: Object.values(ROLES), default: ROLES.CUSTOMER, required: true },
    status: { type: String, enum: Object.values(USER_STATUS), default: USER_STATUS.ACTIVE, required: true },
    isVerified: { type: Boolean, default: false },
    avatar: { type: String, trim: true, maxlength: 2048 },
    // Bumped on password change / logout-all so already-issued access tokens stop working immediately.
    tokenVersion: { type: Number, default: 0 },
    passwordChangedAt: { type: Date },
    lastLoginAt: { type: Date },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        delete ret.tokenVersion;
        delete ret.deletedAt; // internal soft-delete marker
        return ret;
      },
    },
  },
);

// Email and phone are each optional but unique when present. A plain unique index would treat every
// missing value as null and allow only ONE user without an email, so index only real strings.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ role: 1, status: 1 });

userSchema.pre('validate', function requireContact(next) {
  if (!this.email && !this.phone) return next(new Error('Either email or phone is required'));
  return next();
});

export default mongoose.model('User', userSchema);
