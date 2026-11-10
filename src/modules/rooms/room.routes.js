import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { roomService as svc } from './room.service.js';
import { roomValidation as v } from './room.validation.js';

const router = Router();
router.use(authenticate);
const caller = (req) => ({ user: req.user, permissions: req.permissions });

router.get('/availability', authorizePermissions(P.ROOM_READ), validate(v.availability), handle((req) => svc.availability(req.query))); // must stay above '/:id'
router.get('/', authorizePermissions(P.ROOM_READ), validate(v.list), handle((req) => svc.list(caller(req), req.query)));
router.get('/:id', authorizePermissions(P.ROOM_READ), validate(v.params), handle((req) => svc.get(caller(req), req.params.id)));
router.get('/:id/history', authorizeAnyPermission(P.ROOM_MANAGE, P.HOUSEKEEPING_READ), validate(v.params), handle((req) => svc.history(req.params.id)));
router.post('/', authorizePermissions(P.ROOM_MANAGE), validate(v.create), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Room created' }));
router.patch('/:id', authorizePermissions(P.ROOM_MANAGE), validate(v.update), handle((req) => svc.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Room updated' }));
router.patch('/:id/status', authorizePermissions(P.ROOM_MANAGE), validate(v.status), handle((req) => svc.setStatus(caller(req), req.params.id, req.body, ctx(req)), { message: 'Room status updated' }));
router.delete('/:id', authorizePermissions(P.ROOM_MANAGE), validate(v.params), handle((req) => svc.remove(caller(req), req.params.id, ctx(req)).then(() => null), { message: 'Room removed' }));
export default router;
