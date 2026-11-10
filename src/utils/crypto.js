import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/environment.js';

export const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
export const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the account doesn't exist, so login timing doesn't reveal which accounts exist.
let dummyHash;
export const getDummyPasswordHash = async () => (dummyHash ??= await hashPassword('timing-equalizer-password'));

/** SHA-256 is the right tool for high-entropy random tokens (refresh tokens). */
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const generateOpaqueToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

export const generateOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** A 6-digit code has little entropy, so it is HMAC'd with a server secret and bound to identifier + purpose. */
export const hashOtp = (identifier, purpose, otp) =>
  crypto.createHmac('sha256', env.OTP_SECRET).update(`${identifier}:${purpose}:${otp}`).digest('hex');

export const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};
