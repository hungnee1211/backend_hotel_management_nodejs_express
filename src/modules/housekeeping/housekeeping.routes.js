import { Router } from 'express';
import Joi from 'joi';
import { HK_TASK_STATUS, HOUSEKEEPING_STATUS, PRIORITY } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { housekeepingService as svc } from './housekeeping.service.js';

const router = Router();
router.use(authenticate);
const caller = (req) => ({ user: req.user, permissions: req.permissions });
const read = authorizePermissions(P.HOUSEKEEPING_READ);
const work = authorizePermissions(P.HOUSEKEEPING_UPDATE);

router.get('/rooms', read, validate({ query: Joi.object({ ...pagination, housekeepingStatus: Joi.string().valid(...Object.values(HOUSEKEEPING_STATUS)), sortBy: Joi.string().valid('roomNumber', 'floor') }) }), handle((req) => svc.roomsNeedingCleaning(req.query)));
router.get('/tasks', read, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid(...Object.values(HK_TASK_STATUS)), roomId: objectId, assignedStaffId: objectId, priority: Joi.string().valid(...Object.values(PRIORITY)), sortBy: Joi.string().valid('createdAt', 'priority', 'completedAt') }) }), handle((req) => svc.list(caller(req), req.query)));
router.post('/tasks', authorizePermissions(P.HOUSEKEEPING_ASSIGN), validate({ body: Joi.object({ roomId: objectId.required(), taskType: Joi.string().valid('CHECKOUT_CLEAN', 'DAILY_CLEAN', 'DEEP_CLEAN', 'INSPECTION'), priority: Joi.string().valid(...Object.values(PRIORITY)), assignedStaffId: objectId, notes: Joi.string().max(1000) }) }), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Task created' }));
router.get('/tasks/:id', read, validate({ params: idParams }), handle((req) => svc.get(caller(req), req.params.id)));
router.patch('/tasks/:id', authorizePermissions(P.HOUSEKEEPING_ASSIGN), validate({ params: idParams, body: Joi.object({ assignedStaffId: objectId.required() }) }), handle((req) => svc.assign(caller(req), req.params.id, req.body.assignedStaffId, ctx(req)), { message: 'Task assigned' }));
router.post('/tasks/:id/start', work, validate({ params: idParams }), handle((req) => svc.start(caller(req), req.params.id, ctx(req)), { message: 'Cleaning started' }));
router.post('/tasks/:id/complete', work, validate({ params: idParams, body: Joi.object({ notes: Joi.string().max(1000) }) }), handle((req) => svc.complete(caller(req), req.params.id, req.body, ctx(req)), { message: 'Cleaning completed' }));
router.post('/tasks/:id/inspect', authorizePermissions(P.HOUSEKEEPING_INSPECT), validate({ params: idParams, body: Joi.object({ passed: Joi.boolean().required(), notes: Joi.string().max(1000) }) }), handle((req) => svc.inspect(caller(req), req.params.id, req.body, ctx(req)), { message: 'Inspection recorded' }));
router.post('/tasks/:id/damage', work, validate({ params: idParams, body: Joi.object({ description: Joi.string().trim().min(3).max(1000).required(), createMaintenance: Joi.boolean() }) }), handle((req) => svc.reportDamage(caller(req), req.params.id, req.body, ctx(req)), { message: 'Damage reported' }));
export default router;
