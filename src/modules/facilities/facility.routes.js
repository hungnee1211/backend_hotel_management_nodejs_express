import { Router } from 'express';
import Joi from 'joi';
import { EQUIPMENT_STATUS, FACILITY_STATUS, FACILITY_TYPE, MAINT_STATUS, PRIORITY } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { equipmentService as eq } from '../equipment/equipment.service.js';
import { maintenanceService as mt } from '../maintenance/maintenance.service.js';
import { facilityService as fac } from './facility.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);
const hours = Joi.array().items(Joi.object({ day: Joi.number().integer().min(0).max(6).required(), open: hhmm.required(), close: hhmm.required() })).max(7);
const money = Joi.number().integer().min(0);
const date = Joi.date().iso();
const key = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

// ---------------- /api/facilities ----------------
export const facilityRouter = Router();
facilityRouter.use(authenticate);
const fBody = (r) => ({ name: r ? Joi.string().trim().max(120).required() : Joi.string().trim().max(120), type: r ? Joi.string().valid(...Object.values(FACILITY_TYPE)).required() : Joi.string().valid(...Object.values(FACILITY_TYPE)), location: Joi.string().trim().max(200), description: Joi.string().trim().max(1000).allow(''), operatingHours: hours, status: Joi.string().valid(...Object.values(FACILITY_STATUS)), managerId: objectId.allow(null) });
facilityRouter.get('/', authorizePermissions(P.FACILITY_READ), validate({ query: Joi.object({ ...pagination, type: Joi.string().valid(...Object.values(FACILITY_TYPE)), status: Joi.string().valid(...Object.values(FACILITY_STATUS)), managerId: objectId, sortBy: Joi.string().valid('name', 'createdAt') }) }), handle((req) => fac.list(req.query)));
facilityRouter.post('/', authorizePermissions(P.FACILITY_MANAGE), validate({ body: Joi.object(fBody(true)) }), handle((req) => fac.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Facility created' }));
facilityRouter.get('/:id', authorizePermissions(P.FACILITY_READ), validate({ params: idParams }), handle((req) => fac.get(req.params.id)));
facilityRouter.get('/:id/equipment', authorizePermissions(P.EQUIPMENT_READ), validate({ params: idParams, query: Joi.object({ ...pagination, status: Joi.string().valid(...Object.values(EQUIPMENT_STATUS)) }) }), handle((req) => eq.list({ ...req.query, facilityId: req.params.id })));
facilityRouter.patch('/:id', authorizePermissions(P.FACILITY_MANAGE), validate({ params: idParams, body: Joi.object(fBody(false)).min(1) }), handle((req) => fac.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Facility updated' }));
facilityRouter.delete('/:id', authorizePermissions(P.FACILITY_MANAGE), validate({ params: idParams }), handle((req) => fac.remove(caller(req), req.params.id, ctx(req)).then(() => null), { message: 'Facility deactivated' }));

// ---------------- /api/equipment ----------------
export const equipmentRouter = Router();
equipmentRouter.use(authenticate);
const eBody = (r) => ({ name: r ? Joi.string().trim().max(120).required() : Joi.string().trim().max(120), category: Joi.string().trim().max(60), facilityId: r ? objectId.required() : objectId, brand: Joi.string().max(60), model: Joi.string().max(60), description: Joi.string().max(1000), quantity: Joi.number().integer().min(1).max(10000), purchaseDate: date, purchasePriceMinor: money, warrantyExpiration: date, maintenanceIntervalDays: Joi.number().integer().min(1).max(3650), nextMaintenanceAt: date });
equipmentRouter.get('/', authorizePermissions(P.EQUIPMENT_READ), validate({ query: Joi.object({ ...pagination, facilityId: objectId, status: Joi.string().valid(...Object.values(EQUIPMENT_STATUS)), category: Joi.string().max(60), warrantyExpiringDays: Joi.number().integer().min(0).max(3650), maintenanceDueDays: Joi.number().integer().min(0).max(3650), sortBy: Joi.string().valid('name', 'equipmentCode', 'nextMaintenanceAt', 'createdAt') }) }), handle((req) => eq.list(req.query)));
equipmentRouter.post('/', authorizePermissions(P.EQUIPMENT_MANAGE), validate({ body: Joi.object(eBody(true)) }), handle((req) => eq.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Equipment registered' }));
equipmentRouter.get('/:id', authorizePermissions(P.EQUIPMENT_READ), validate({ params: idParams }), handle((req) => eq.get(req.params.id)));
equipmentRouter.get('/:id/history', authorizePermissions(P.EQUIPMENT_READ), validate({ params: idParams }), handle((req) => eq.history(req.params.id)));
equipmentRouter.patch('/:id', authorizePermissions(P.EQUIPMENT_MANAGE), validate({ params: idParams, body: Joi.object({ ...eBody(false), status: Joi.string().valid('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED') }).min(1) }), handle((req) => eq.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Equipment updated' }));
equipmentRouter.delete('/:id', authorizePermissions(P.EQUIPMENT_MANAGE), validate({ params: idParams }), handle((req) => eq.retire(caller(req), req.params.id, ctx(req)), { message: 'Equipment retired' }));

// ---------------- /api/maintenance ----------------
export const maintenanceRouter = Router();
maintenanceRouter.use(authenticate);
const anyMaint = authorizePermissions(P.MAINTENANCE_REPORT);
maintenanceRouter.post('/', anyMaint, validate({ body: Joi.object({ type: Joi.string().valid('CORRECTIVE', 'PREVENTIVE'), equipmentId: objectId, facilityId: objectId, roomId: objectId, blockFrom: key, blockTo: key, title: Joi.string().trim().min(3).max(200).required(), description: Joi.string().trim().max(2000), priority: Joi.string().valid(...Object.values(PRIORITY)), estimatedCostMinor: money, scheduledFor: date }).and('blockFrom', 'blockTo') }), handle((req) => mt.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Maintenance request created' }));
maintenanceRouter.get('/', anyMaint, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid(...Object.values(MAINT_STATUS)), priority: Joi.string().valid(...Object.values(PRIORITY)), type: Joi.string().valid('CORRECTIVE', 'PREVENTIVE'), equipmentId: objectId, facilityId: objectId, roomId: objectId, assignedStaffId: objectId, sortBy: Joi.string().valid('createdAt', 'priority', 'scheduledFor') }) }), handle((req) => mt.list(caller(req), req.query)));
maintenanceRouter.get('/:id', anyMaint, validate({ params: idParams }), handle((req) => mt.get(caller(req), req.params.id)));
maintenanceRouter.patch('/:id', anyMaint, validate({ params: idParams, body: Joi.object({ description: Joi.string().trim().max(2000), estimatedCostMinor: money, actualCostMinor: money, priority: Joi.string().valid(...Object.values(PRIORITY)) }).min(1) }), handle((req) => mt.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Maintenance request updated' }));
maintenanceRouter.post('/:id/assign', authorizePermissions(P.MAINTENANCE_MANAGE), validate({ params: idParams, body: Joi.object({ assignedStaffId: objectId.required() }) }), handle((req) => mt.assign(caller(req), req.params.id, req.body.assignedStaffId, ctx(req)), { message: 'Assigned' }));
maintenanceRouter.post('/:id/start', anyMaint, validate({ params: idParams }), handle((req) => mt.start(caller(req), req.params.id, ctx(req)), { message: 'Work started' }));
maintenanceRouter.post('/:id/complete', anyMaint, validate({ params: idParams, body: Joi.object({ actualCostMinor: money, resolution: Joi.string().trim().max(1000) }) }), handle((req) => mt.complete(caller(req), req.params.id, req.body, ctx(req)), { message: 'Maintenance completed' }));
maintenanceRouter.post('/:id/cancel', anyMaint, validate({ params: idParams }), handle((req) => mt.cancel(caller(req), req.params.id, ctx(req)), { message: 'Maintenance cancelled' }));
