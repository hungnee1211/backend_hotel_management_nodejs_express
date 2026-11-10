import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as c from './guest.controller.js';
import { guestValidation as v } from './guest.validation.js';

const router = Router();
router.use(authenticate);

// Front-desk roles work with every guest (GUEST_READ / GUEST_MANAGE); customers only with their own
// (GUEST_MANAGE_OWN). The service applies that scope; the route only checks that one of them is held.
const read = authorizeAnyPermission(P.GUEST_READ, P.GUEST_MANAGE_OWN);
const write = authorizeAnyPermission(P.GUEST_MANAGE, P.GUEST_MANAGE_OWN);

router.post('/', write, validate(v.create), c.create);
router.get('/', read, validate(v.list), c.list);
router.get('/:id', read, validate(v.get), c.get);
router.patch('/:id', write, validate(v.update), c.update);
router.delete('/:id', authorizePermissions(P.GUEST_DELETE), validate(v.params), c.remove);

export default router;
