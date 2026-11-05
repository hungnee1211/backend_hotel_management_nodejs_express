import { env } from '../../config/environment.js';
import { ApiError } from '../../utils/ApiError.js';
import { generateOtp, hashOtp, safeEqual } from '../../utils/crypto.js';
import { notificationService } from '../notifications/notification.service.js';
import { authRepository } from './auth.repository.js';

const HOUR_MS = 60 * 60 * 1000;
const invalidCode = () => ApiError.badRequest('Invalid or expired code', 'OTP_INVALID');

export const otpService = {
  /** Creates a new code (superseding older ones) and "sends" it. Enforces cooldown and hourly cap. */
  async issue({ user, purpose }) {
    const identifier = user.email ?? user.phone;
    const now = Date.now();

    const latest = await authRepository.findLatestOtp(identifier, purpose);
    if (latest && now - latest.createdAt.getTime() < env.otpResendCooldownMs) {
      throw ApiError.tooManyRequests('Please wait before requesting another code', 'OTP_COOLDOWN');
    }
    if ((await authRepository.countOtpsSince(identifier, purpose, new Date(now - HOUR_MS))) >= env.OTP_MAX_RESENDS_PER_HOUR) {
      throw ApiError.tooManyRequests('Too many codes requested. Try again later.', 'OTP_LIMIT_REACHED');
    }

    const otp = generateOtp();
    await authRepository.supersedeOtps(identifier, purpose);
    await authRepository.createOtp({
      identifier,
      purpose,
      hashedCode: hashOtp(identifier, purpose, otp),
      expiresAt: new Date(now + env.otpTtlMs),
    });
    await notificationService.sendOtp({
      channel: user.email ? 'EMAIL' : 'SMS',
      destination: identifier,
      otp,
      purpose,
    });
  },

  /** Verifies and consumes the code (single use). Throws a generic error for every failure except lockout. */
  async verify({ user, purpose, otp }) {
    const identifier = user.email ?? user.phone;
    const record = await authRepository.findPendingOtp(identifier, purpose);
    if (!record) throw invalidCode();
    if (record.expiresAt <= new Date()) throw ApiError.badRequest('Code has expired', 'OTP_EXPIRED');

    // Count the attempt BEFORE comparing (atomically) so parallel guesses cannot exceed the limit.
    const counted = await authRepository.registerOtpAttempt(record._id, env.OTP_MAX_ATTEMPTS);
    if (!counted) throw ApiError.tooManyRequests('Too many failed attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED');

    if (!safeEqual(record.hashedCode, hashOtp(identifier, purpose, otp))) throw invalidCode();
    if (!(await authRepository.markOtpUsed(record._id))) throw invalidCode(); // lost a race with another verify
  },
};
