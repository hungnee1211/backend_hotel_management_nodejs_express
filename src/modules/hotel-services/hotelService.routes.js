import { Router } from 'express';
import Joi from 'joi';
import { PRICING_TYPE, SERVICE_CATEGORY, SERVICE_REQUEST_STATUS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { hotelServiceService as svc } from './hotelService.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const money = Joi.number().integer().min(0);
const body = (r) => ({ name: r ? Joi.string().trim().max(120).required() : Joi.string().trim().max(120), description: Joi.string().trim().max(1000).allow(''), category: Joi.string().valid(...Object.values(SERVICE_CATEGORY)), priceMinor: r ? money.required() : money, pricingType: Joi.string().valid(...Object.values(PRICING_TYPE)), availability: Joi.boolean(), status: Joi.string().valid('ACTIVE', 'INACTIVE') });

/** /api/services: the catalogue */
export const serviceRouter = Router();
serviceRouter.use(authenticate);
serviceRouter.get('/', authorizePermissions(P.SERVICE_READ), validate({ query: Joi.object({ ...pagination, category: Joi.string().valid(...Object.values(SERVICE_CATEGORY)), sortBy: Joi.string().valid('name', 'priceMinor', 'createdAt') }) }), handle((req) => svc.list(caller(req), req.query)));
serviceRouter.post('/', authorizePermissions(P.SERVICE_MANAGE), validate({ body: Joi.object(body(true)) }), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Service created' }));
serviceRouter.patch('/:id', authorizePermissions(P.SERVICE_MANAGE), validate({ params: idParams, body: Joi.object(body(false)).min(1) }), handle((req) => svc.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Service updated' }));

/** /api/service-requests */
export const serviceRequestRouter = Router();
serviceRequestRouter.use(authenticate);
const any = authorizeAnyPermission(P.SERVICE_REQUEST_OWN, P.SERVICE_FULFILL, P.SERVICE_MANAGE);
serviceRequestRouter.post('/', authorizePermissions(P.SERVICE_REQUEST_OWN), validate({ body: Joi.object({ bookingId: objectId.required(), hotelServiceId: objectId.required(), quantity: Joi.number().integer().min(1).max(100), scheduledAt: Joi.date().iso(), notes: Joi.string().trim().max(500) }) }), handle((req) => svc.request(caller(req), req.body, ctx(req)), { status: 201, message: 'Service requested' }));
serviceRequestRouter.get('/', any, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid(...Object.values(SERVICE_REQUEST_STATUS)), bookingId: objectId, sortBy: Joi.string().valid('createdAt') }) }), handle((req) => svc.listRequests(caller(req), req.query)));
serviceRequestRouter.get('/:id', any, validate({ params: idParams }), handle((req) => svc.getRequest(caller(req), req.params.id)));
serviceRequestRouter.patch('/:id/status', authorizeAnyPermission(P.SERVICE_FULFILL, P.SERVICE_MANAGE), validate({ params: idParams, body: Joi.object({ status: Joi.string().valid(...Object.values(SERVICE_REQUEST_STATUS)).required(), assignedStaffId: objectId, reason: Joi.string().trim().max(300) }) }), handle((req) => svc.updateStatus(caller(req), req.params.id, req.body, ctx(req)), { message: 'Request updated' }));
serviceRequestRouter.post('/:id/cancel', any, validate({ params: idParams, body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }) }), handle((req) => svc.cancel(caller(req), req.params.id, req.body, ctx(req)), { message: 'Request cancelled' }));
