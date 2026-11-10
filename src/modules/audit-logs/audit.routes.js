import { Router } from 'express';
import Joi from 'joi';
import AuditLog from '../../models/AuditLog.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { objectId, pagination } from '../../utils/joi-rules.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';

const router = Router();
router.use(authenticate, authorizePermissions(P.AUDIT_LOG_READ)); // Admin only
router.get('/', validate({ query: Joi.object({ ...pagination, actorId: objectId, action: Joi.string().max(60), resourceType: Joi.string().max(40), resourceId: objectId, from: Joi.date().iso(), to: Joi.date().iso() }) }),
  handle(async (req) => {
    const q = req.query; const paging = parsePagination(q, { defaultSort: 'createdAt' });
    const filter = {};
    for (const k of ['actorId', 'action', 'resourceType', 'resourceId']) if (q[k]) filter[k] = q[k];
    if (q.from || q.to) filter.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: q.to }) };
    const [items, total] = await Promise.all([AuditLog.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit).lean(), AuditLog.countDocuments(filter)]);
    return { items, meta: buildPageMeta({ ...paging, total }) };
  }));
export default router;
