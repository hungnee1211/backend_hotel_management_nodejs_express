import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { roomTypeService as svc } from './roomType.service.js';
import { roomTypeValidation as v } from './roomType.validation.js';

const router = Router();
router.use(authenticate);
const caller = (req) => ({ user: req.user, permissions: req.permissions });
router.get('/', authorizePermissions(P.ROOM_READ), validate(v.list), handle((req) => svc.list(req.query, caller(req))));
router.get('/:id', authorizePermissions(P.ROOM_READ), validate(v.params), handle((req) => svc.get(req.params.id, caller(req))));
router.post('/', authorizePermissions(P.ROOM_MANAGE), validate(v.create), handle((req) => svc.create(caller(req), req.body, ctx(req)), { status: 201, message: 'Room type created' }));
router.patch('/:id', authorizePermissions(P.ROOM_MANAGE), validate(v.update), handle((req) => svc.update(caller(req), req.params.id, req.body, ctx(req)), { message: 'Room type updated' }));
export default router;
