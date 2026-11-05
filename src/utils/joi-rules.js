import Joi from 'joi';
import { PHONE_REGEX, normalizeEmail, normalizePhone } from './identifier.js';

/** Reusable Joi rules shared by every module's validation file. */

export const objectId = Joi.string().hex().length(24).messages({ 'string.length': 'must be a valid id', 'string.hex': 'must be a valid id' });
export const idParams = Joi.object({ id: objectId.required() });

export const email = Joi.string().trim().max(254).email({ tlds: { allow: false } }).custom((v) => normalizeEmail(v));

export const phone = Joi.string().trim().custom((value, helpers) => {
  const normalized = normalizePhone(value);
  return PHONE_REGEX.test(normalized) ? normalized : helpers.error('any.invalid');
}).messages({ 'any.invalid': 'must be a valid phone number (8-15 digits, optional leading +)' });

/** A login/OTP identifier: either an email or a phone number, normalized. */
export const identifier = Joi.string().trim().max(254).custom((value, helpers) => {
  if (value.includes('@')) {
    return Joi.string().email({ tlds: { allow: false } }).validate(value).error ? helpers.error('any.invalid') : normalizeEmail(value);
  }
  const normalized = normalizePhone(value);
  return PHONE_REGEX.test(normalized) ? normalized : helpers.error('any.invalid');
}).messages({ 'any.invalid': 'must be a valid email address or phone number' });

// bcrypt only uses the first 72 BYTES of a password, so reject anything longer instead of silently truncating.
export const password = Joi.string().min(8).max(72)
  .pattern(/[A-Za-z]/, 'letter').pattern(/\d/, 'digit')
  .custom((v, helpers) => (Buffer.byteLength(v) > 72 ? helpers.error('string.max', { limit: 72 }) : v))
  .messages({ 'string.pattern.name': 'must contain at least one letter and one digit' });

export const fullName = Joi.string().trim().min(2).max(120);

export const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  order: Joi.string().valid('asc', 'desc').default('desc'),
  search: Joi.string().trim().max(100),
};
