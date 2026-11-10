import 'dotenv/config';
import Joi from 'joi';
import { parseDuration } from '../utils/duration.js';

const duration = (fallback) => Joi.string().pattern(/^\d+(ms|s|m|h|d)$/).default(fallback);
const optionalString = Joi.string().allow('').optional();

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(5000),
  TRUST_PROXY: Joi.number().integer().min(0).default(0),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),

  MONGODB_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),
  ALLOW_STANDALONE_MONGO: Joi.boolean().default(false),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: duration('15m'),
  JWT_REFRESH_EXPIRES_IN: duration('7d'),
  OTP_SECRET: Joi.string().min(32).required(),
  // 32-byte key (64 hex chars) that encrypts guest identification numbers (AES-256-GCM). Generate: openssl rand -hex 32
  PII_ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  OTP_EXPIRES_IN: duration('5m'),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN: duration('60s'),
  OTP_MAX_RESENDS_PER_HOUR: Joi.number().integer().min(1).max(20).default(5),
  BCRYPT_ROUNDS: Joi.number().integer().min(4).max(15).default(12),

  COOKIE_DOMAIN: optionalString,
  COOKIE_SECURE: Joi.boolean().empty('').optional(),
  COOKIE_SAME_SITE: Joi.string().valid('lax', 'strict', 'none').default('lax'),
  CLIENT_URL: Joi.string().default('http://localhost:3000'),

  ENABLE_JOBS: Joi.boolean().default(true),
  ENABLE_DOCS: Joi.boolean().optional(),
  HOTEL_TIMEZONE: Joi.string().default('Asia/Ho_Chi_Minh'),
  HOTEL_CURRENCY: Joi.string().length(3).uppercase().default('VND'),

  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  PAYMENT_PROVIDER: Joi.string().valid('mock').default('mock'),
  PAYMENT_SECRET_KEY: optionalString,
  PAYMENT_WEBHOOK_SECRET: optionalString,

  // Used only by `yarn create-admin` to bootstrap the first Admin account.
  ADMIN_NAME: optionalString,
  ADMIN_EMAIL: optionalString,
  ADMIN_PHONE: optionalString,
  ADMIN_PASSWORD: optionalString,
}).unknown(true);

const { value, error } = schema.validate(process.env, { abortEarly: false });
if (error) {
  // The logger depends on this module, so report with console and stop immediately.
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${error.details.map((d) => `  - ${d.message}`).join('\n')}`);
  process.exit(1);
}

try {
  new Intl.DateTimeFormat('en-US', { timeZone: value.HOTEL_TIMEZONE });
} catch {
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration: HOTEL_TIMEZONE "${value.HOTEL_TIMEZONE}" is not a valid IANA time zone`);
  process.exit(1);
}

const isProd = value.NODE_ENV === 'production';

export const env = Object.freeze({
  ...value,
  isProd,
  isDev: value.NODE_ENV === 'development',
  isTest: value.NODE_ENV === 'test',
  // SameSite=None is rejected by browsers unless the cookie is Secure.
  jobsEnabled: value.ENABLE_JOBS && value.NODE_ENV !== 'test',
  docsEnabled: value.ENABLE_DOCS ?? !isProd,
  cookieSecure: value.COOKIE_SAME_SITE === 'none' ? true : (value.COOKIE_SECURE ?? isProd),
  clientOrigins: value.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean),
  accessTokenTtlMs: parseDuration(value.JWT_ACCESS_EXPIRES_IN),
  refreshTokenTtlMs: parseDuration(value.JWT_REFRESH_EXPIRES_IN),
  otpTtlMs: parseDuration(value.OTP_EXPIRES_IN),
  otpResendCooldownMs: parseDuration(value.OTP_RESEND_COOLDOWN),
});
