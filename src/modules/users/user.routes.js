import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import * as c from './user.controller.js';
import { userValidation as v } from './user.validation.js';

const router = Router();
router.use(authenticate);

// Who may call what is decided here; WHICH users they may touch (scope) is decided in user.service.
const manage = authorizeAnyPermission(P.USER_MANAGE_STAFF, P.USER_MANAGE_MANAGERS);

router.get('/', authorizePermissions(P.USER_READ), validate(v.list), c.list);
router.get('/:id', authorizePermissions(P.USER_READ), validate(v.params), c.get);
router.patch('/:id', manage, validate(v.update), c.update);
router.post('/:id/deactivate', manage, validate(v.params), c.deactivate);
router.post('/:id/reactivate', manage, validate(v.params), c.reactivate);
router.delete('/:id', authorizePermissions(P.USER_MANAGE_MANAGERS), validate(v.params), c.remove); // Admin only

export default router;
