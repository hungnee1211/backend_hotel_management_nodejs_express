import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { settingsService as svc } from './settings.service.js';
import { settingsValidation as v } from './settings.validation.js';

export const settingsRouter = Router();
settingsRouter.use(authenticate);
settingsRouter.get('/', authorizeAnyPermission(P.SETTINGS_MANAGE, P.INVOICE_MANAGE), handle(() => svc.get()));
settingsRouter.patch('/', authorizePermissions(P.SETTINGS_MANAGE), validate(v.update), handle((req) => svc.update(req.user, req.body, ctx(req)), { message: 'Settings updated' }));

export const taxRuleRouter = Router();
taxRuleRouter.use(authenticate);
taxRuleRouter.get('/', authorizeAnyPermission(P.TAX_RULE_MANAGE, P.INVOICE_MANAGE), handle(() => svc.listTaxRules()));
taxRuleRouter.post('/', authorizePermissions(P.TAX_RULE_MANAGE), validate(v.createTaxRule), handle((req) => svc.createTaxRule(req.user, req.body, ctx(req)), { status: 201, message: 'Tax rule created' }));
taxRuleRouter.patch('/:id', authorizePermissions(P.TAX_RULE_MANAGE), validate(v.updateTaxRule), handle((req) => svc.updateTaxRule(req.user, req.params.id, req.body, ctx(req)), { message: 'Tax rule updated' }));
