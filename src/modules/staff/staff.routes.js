import { Router } from 'express';
import { ROLES } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions, authorizeRoles } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as c from './staff.controller.js';
import { staffValidation as v } from './staff.validation.js';

/** /api/staff */
export const staffRouter = Router();
staffRouter.use(authenticate);

staffRouter.get('/me', authorizeRoles(ROLES.STAFF), c.me); // must stay above '/:id'
staffRouter.post('/', authorizePermissions(P.USER_MANAGE_STAFF), validate(v.create), c.create);
staffRouter.get('/', authorizePermissions(P.USER_READ), validate(v.list), c.list);
staffRouter.get('/:id', authorizePermissions(P.USER_READ), validate(v.params), c.get);
staffRouter.get('/:id/permissions', authorizePermissions(P.USER_READ), validate(v.params), c.permissions);
staffRouter.patch('/:id', authorizePermissions(P.USER_MANAGE_STAFF), validate(v.update), c.update);

/** /api/managers (Admin only) */
export const managerRouter = Router();
managerRouter.use(authenticate, authorizePermissions(P.USER_MANAGE_MANAGERS));

managerRouter.post('/', validate(v.createManager), c.createManager);
managerRouter.post('/:id/transfer-staff', validate(v.transfer), c.transferStaff);
