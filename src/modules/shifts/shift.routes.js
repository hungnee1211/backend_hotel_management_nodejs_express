import { Router } from 'express';
import Joi from 'joi';
import { DEPARTMENTS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { shiftService as svc } from './shift.service.js';
import { attendanceService as att } from '../attendance/attendance.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const key = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);
const iso = Joi.date().iso().max('now');

export const shiftRouter = Router();
shiftRouter.use(authenticate);
shiftRouter.get('/', authorizeAnyPermission(P.SHIFT_MANAGE, P.ATTENDANCE_SELF), validate({ query: Joi.object({ ...pagination, staffId: objectId, status: Joi.string().valid('SCHEDULED', 'CANCELLED'), department: Joi.string().valid(...Object.values(DEPARTMENTS)), from: key, to: key, sortBy: Joi.string().valid('date', 'createdAt') }) }), handle((req) => svc.list(caller(req), req.query)));
shiftRouter.post('/', authorizePermissions(P.SHIFT_MANAGE), validate({ body: Joi.object({ staffId: objectId.required(), date: key.required(), startTime: hhmm.required(), endTime: hhmm.required() }) }), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Shift created' }));
shiftRouter.patch('/:id', authorizePermissions(P.SHIFT_MANAGE), validate({ params: idParams, body: Joi.object({ date: key, startTime: hhmm, endTime: hhmm }).min(1) }), handle((req) => svc.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Shift updated' }));
shiftRouter.delete('/:id', authorizePermissions(P.SHIFT_MANAGE), validate({ params: idParams }), handle((req) => svc.cancel(caller(req), req.params.id, ctx(req)), { message: 'Shift cancelled' }));

export const attendanceRouter = Router();
attendanceRouter.use(authenticate);
const self = authorizePermissions(P.ATTENDANCE_SELF);
const team = authorizeAnyPermission(P.ATTENDANCE_SELF, P.ATTENDANCE_READ_TEAM);
attendanceRouter.post('/check-in', self, handle((req) => att.checkIn(caller(req), ctx(req)), { status: 201, message: 'Checked in' }));
attendanceRouter.post('/check-out', self, handle((req) => att.checkOut(caller(req), ctx(req)), { message: 'Checked out' }));
attendanceRouter.get('/reports', authorizePermissions(P.ATTENDANCE_READ_TEAM), validate({ query: Joi.object({ month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required(), staffId: objectId, department: Joi.string().valid(...Object.values(DEPARTMENTS)) }) }), handle((req) => att.report(caller(req), req.query)));
attendanceRouter.get('/', team, validate({ query: Joi.object({ ...pagination, staffId: objectId, status: Joi.string().valid('OPEN', 'CLOSED', 'MISSING_CHECKOUT', 'ABSENT'), from: key, to: key, late: Joi.boolean(), sortBy: Joi.string().valid('date', 'createdAt') }) }), handle((req) => att.list(caller(req), req.query)));
attendanceRouter.get('/:id', team, validate({ params: idParams }), handle((req) => att.get(caller(req), req.params.id)));
attendanceRouter.post('/:id/correction-request', self, validate({ params: idParams, body: Joi.object({ checkInAt: iso, checkOutAt: iso, reason: Joi.string().trim().min(5).max(300).required() }).or('checkInAt', 'checkOutAt') }), handle((req) => att.requestCorrection(caller(req), req.params.id, req.body, ctx(req)), { message: 'Correction requested' }));
attendanceRouter.post('/:id/correction/approve', authorizePermissions(P.ATTENDANCE_APPROVE), validate({ params: idParams }), handle((req) => att.decideCorrection(caller(req), req.params.id, true, ctx(req)), { message: 'Correction approved' }));
attendanceRouter.post('/:id/correction/reject', authorizePermissions(P.ATTENDANCE_APPROVE), validate({ params: idParams }), handle((req) => att.decideCorrection(caller(req), req.params.id, false, ctx(req)), { message: 'Correction rejected' }));
attendanceRouter.patch('/:id', authorizePermissions(P.ATTENDANCE_APPROVE), validate({ params: idParams, body: Joi.object({ checkInAt: iso, checkOutAt: iso, note: Joi.string().max(300) }).min(1) }), handle((req) => att.correct(caller(req), req.params.id, req.body, ctx(req)), { message: 'Attendance corrected' }));
