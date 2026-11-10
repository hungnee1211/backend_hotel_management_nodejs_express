import OTP from '../../models/OTP.js';
import RefreshToken from '../../models/RefreshToken.js';

export const authRepository = {
  // ---------- OTP ----------
  createOtp: async (data) => (await OTP.create([data]))[0],
  findLatestOtp: (identifier, purpose) => OTP.findOne({ identifier, purpose }).sort({ createdAt: -1 }),
  countOtpsSince: (identifier, purpose, since) => OTP.countDocuments({ identifier, purpose, createdAt: { $gte: since } }),
  /** Marks every still-open code as used so only the newest code can ever be verified. */
  supersedeOtps: (identifier, purpose) =>
    OTP.updateMany({ identifier, purpose, usedAt: null }, { $set: { usedAt: new Date() } }),
  findPendingOtp: (identifier, purpose) =>
    OTP.findOne({ identifier, purpose, usedAt: null }).sort({ createdAt: -1 }).select('+hashedCode'),
  /** Atomic: returns null when the code is already used or the attempt budget is spent. */
  registerOtpAttempt: (id, maxAttempts) =>
    OTP.findOneAndUpdate({ _id: id, usedAt: null, attempts: { $lt: maxAttempts } }, { $inc: { attempts: 1 } }, { new: true }),
  /** Atomic single-use: only one caller can flip usedAt from null. */
  markOtpUsed: (id) => OTP.findOneAndUpdate({ _id: id, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true }),

  // ---------- Refresh tokens ----------
  createRefreshToken: async (data) => (await RefreshToken.create([data]))[0],
  findRefreshTokenByHash: (tokenHash) => RefreshToken.findOne({ tokenHash }),
  /** Atomic rotation step: only one concurrent caller can revoke an active token. */
  revokeRefreshTokenIfActive: (tokenHash) => {
    const now = new Date();
    return RefreshToken.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { revokedAt: now } },
      { new: true },
    );
  },
  setReplacedBy: (id, replacedByTokenId) => RefreshToken.updateOne({ _id: id }, { $set: { replacedByTokenId } }),
  revokeFamily: (familyId) => RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } }),
  revokeAllForUser: (userId) => RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } }),
};
