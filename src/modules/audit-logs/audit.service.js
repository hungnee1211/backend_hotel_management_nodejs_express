import { auditRepository } from './audit.repository.js';
import { logger } from '../../utils/logger.js';

const SENSITIVE_KEYS = new Set(['password', 'hashedCode', 'tokenHash', 'token', 'otp', 'tokenVersion']);

const redact = (value) => {
  if (value == null) return value;
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (Array.isArray(plain)) return plain.map(redact);
  if (typeof plain !== 'object' || plain instanceof Date) return plain;
  return Object.fromEntries(Object.entries(plain).filter(([k]) => !SENSITIVE_KEYS.has(k)).map(([k, v]) => [k, redact(v)]));
};

export const auditService = {
  /** Shorthand used by feature modules: log(actor, ctx, 'BOOKING_CREATED', 'Booking', id, { before, after }). */
  log(actor, ctx, action, resourceType, resourceId, { before, after } = {}) {
    return this.record({ actorId: actor?._id ?? null, action, resourceType, resourceId, before, after, ctx });
  },

  /** Never throws: a failed audit write must not break the operation being audited (it is logged loudly instead). */
  async record({ actorId = null, action, resourceType, resourceId = null, before, after, ctx = {} }) {
    try {
      await auditRepository.create({
        actorId,
        action,
        resourceType,
        resourceId,
        before: redact(before),
        after: redact(after),
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
    } catch (err) {
      logger.error('Failed to write audit log', { action, resourceType, error: err.message });
    }
  },
};
