import { Router } from 'express';
import Joi from 'joi';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { menuService as svc } from './menu.service.js';

const router = Router();
router.use(authenticate);
const caller = (req) => ({ user: req.user, permissions: req.permissions });
const money = Joi.number().integer().min(0);
const https = Joi.string().uri({ scheme: ['https'] });
const cat = (r) => ({ name: r ? Joi.string().trim().max(80).required() : Joi.string().trim().max(80), description: Joi.string().trim().max(500).allow(''), image: https, status: Joi.string().valid('ACTIVE', 'INACTIVE') });
const item = (r) => ({ categoryId: r ? objectId.required() : objectId, name: r ? Joi.string().trim().max(120).required() : Joi.string().trim().max(120), description: Joi.string().trim().max(1000).allow(''), priceMinor: r ? money.required() : money, images: Joi.array().items(https).max(10), preparationMinutes: Joi.number().integer().min(0).max(600), availability: Joi.boolean(), status: Joi.string().valid('ACTIVE', 'INACTIVE') });
const read = authorizePermissions(P.MENU_READ); const write = authorizePermissions(P.MENU_MANAGE);

router.get('/', read, validate({ query: Joi.object({ categoryId: objectId, search: Joi.string().trim().max(60), minPrice: money, maxPrice: money, available: Joi.boolean(), includeInactive: Joi.boolean() }) }), handle((req) => svc.menu(caller(req), req.query)));
router.post('/categories', write, validate({ body: Joi.object(cat(true)) }), handle((req) => svc.createCategory(caller(req), req.body, ctx(req)), { status: 201, message: 'Category created' }));
router.patch('/categories/:id', write, validate({ params: idParams, body: Joi.object(cat(false)).min(1) }), handle((req) => svc.updateCategory(caller(req), req.params.id, req.body, ctx(req)), { message: 'Category updated' }));
router.post('/items', write, validate({ body: Joi.object(item(true)) }), handle((req) => svc.createItem(caller(req), req.body, ctx(req)), { status: 201, message: 'Item created' }));
router.get('/items/:id', read, validate({ params: idParams }), handle((req) => svc.getItem(caller(req), req.params.id)));
router.patch('/items/:id', write, validate({ params: idParams, body: Joi.object(item(false)).min(1) }), handle((req) => svc.updateItem(caller(req), req.params.id, req.body, ctx(req)), { message: 'Item updated' }));
export default router;
