import { Router } from 'express';
import Joi from 'joi';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, pagination } from '../../utils/joi-rules.js';
import { inAppNotifications as svc } from './notification.repository.service.js';

const router = Router();
router.use(authenticate); // every user reads only their own notifications
router.get('/', validate({ query: Joi.object({ ...pagination, unread: Joi.boolean(), sortBy: Joi.string().valid('createdAt') }) }), handle((req) => svc.list(req.user, req.query)));
router.post('/read-all', handle((req) => svc.markAllRead(req.user)));
router.post('/:id/read', validate({ params: idParams }), handle((req) => svc.markRead(req.user, req.params.id)));
export default router;
