import { Router } from 'express';
import Joi from 'joi';
import { ORDER_PAYMENT, ORDER_STATUS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { orderService as svc } from './order.service.js';

const router = Router();
router.use(authenticate);
const caller = (req) => ({ user: req.user, permissions: req.permissions });
const anyOrder = authorizeAnyPermission(P.ORDER_READ_OWN, P.ORDER_PROCESS, P.ORDER_MANAGE);

router.post('/', authorizePermissions(P.ORDER_CREATE_OWN), validate({ body: Joi.object({ bookingId: objectId, roomId: objectId, items: Joi.array().items(Joi.object({ menuItemId: objectId.required(), quantity: Joi.number().integer().min(1).max(50).required(), note: Joi.string().trim().max(200) })).min(1).max(30).required(), paymentMethod: Joi.string().valid(...Object.values(ORDER_PAYMENT)).required(), notes: Joi.string().trim().max(500), deliveryLocation: Joi.string().trim().max(100) }) }), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Order placed' }));
router.get('/', anyOrder, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid(...Object.values(ORDER_STATUS)), bookingId: objectId, roomId: objectId, active: Joi.boolean(), sortBy: Joi.string().valid('createdAt') }) }), handle((req) => svc.list(caller(req), req.query)));
router.get('/:id', anyOrder, validate({ params: idParams }), handle((req) => svc.get(caller(req), req.params.id)));
router.patch('/:id/status', authorizeAnyPermission(P.ORDER_PROCESS, P.ORDER_MANAGE), validate({ params: idParams, body: Joi.object({ status: Joi.string().valid(...Object.values(ORDER_STATUS)).required(), deliveryStaffId: objectId, reason: Joi.string().trim().max(300) }) }), handle((req) => svc.updateStatus(caller(req), req.params.id, req.body, ctx(req)), { message: 'Order updated' }));
router.post('/:id/cancel', anyOrder, validate({ params: idParams, body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }) }), handle((req) => svc.cancel(caller(req), req.params.id, req.body, ctx(req)), { message: 'Order cancelled' }));
router.post('/:id/complete', anyOrder, validate({ params: idParams }), handle((req) => svc.complete(caller(req), req.params.id, ctx(req)), { message: 'Order completed' }));
export default router;
