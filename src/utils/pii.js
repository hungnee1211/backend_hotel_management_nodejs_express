import crypto from 'node:crypto';
import { env } from '../config/environment.js';

/**
 * Field-level protection for identification numbers (passport / national ID).
 *  - encryptPii: AES-256-GCM with a random IV per value. Authenticated, so tampering is detected.
 *    Format "v1.<iv>.<tag>.<ciphertext>" (base64url); the version prefix allows future key rotation.
 *  - blindIndex: deterministic HMAC so staff can look a guest up by ID number without decrypting
 *    every record. It reveals only whether two values are equal.
 */
const key = () => Buffer.from(env.PII_ENCRYPTION_KEY, 'hex');
const normalize = (value) => String(value).toUpperCase().replace(/[\s-]/g, '');

export const encryptPii = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
};

export const decryptPii = (token) => {
  const [version, iv, tag, ciphertext] = String(token).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported or malformed encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

export const blindIndex = (plain) => crypto.createHmac('sha256', key()).update(`pii-index:${normalize(plain)}`).digest('hex');

export const lastFour = (plain) => normalize(plain).slice(-4);
