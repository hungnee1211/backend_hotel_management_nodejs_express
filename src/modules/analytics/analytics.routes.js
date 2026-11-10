import { Router } from 'express';
import Joi from 'joi';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizePermissions } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { handle } from '../../utils/handler.js';
import { dashboardService } from '../dashboard/dashboard.service.js';
import { analyticsService as svc } from './analytics.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const key = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = Joi.object({ period: Joi.string().valid('month', 'quarter', 'year'), year: Joi.number().integer().min(2000).max(2100), month: Joi.number().integer().min(1).max(12), quarter: Joi.number().integer().min(1).max(4), from: key, to: key });
const financial = authorizePermissions(P.REPORT_FINANCIAL);
const operational = authorizePermissions(P.REPORT_OPERATIONAL);

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);
analyticsRouter.get('/overview', financial, validate({ query: rangeQuery }), handle((req) => svc.overview(caller(req), req.query)));
analyticsRouter.get('/revenue', financial, validate({ query: rangeQuery }), handle(async (req) => svc.revenue((await svc.range(req.query)).range)));
analyticsRouter.get('/occupancy', operational, validate({ query: rangeQuery }), handle(async (req) => { const { tz, range } = await svc.range(req.query); return svc.occupancy(range, tz); }));
analyticsRouter.get('/food-beverage', operational, validate({ query: rangeQuery }), handle(async (req) => svc.foodBeverage((await svc.range(req.query)).range)));
analyticsRouter.get('/staff', operational, validate({ query: rangeQuery }), handle(async (req) => svc.staff(caller(req), (await svc.range(req.query)).range)));
analyticsRouter.get('/maintenance', operational, validate({ query: rangeQuery }), handle(async (req) => svc.maintenance(caller(req), (await svc.range(req.query)).range)));
analyticsRouter.get('/monthly', financial, validate({ query: Joi.object({ year: Joi.number().integer().min(2000).max(2100).default(new Date().getFullYear()), compareYear: Joi.number().integer().min(2000).max(2100) }) }), handle((req) => svc.monthly(req.query)));

export const dashboardRouter = Router();
dashboardRouter.use(authenticate); // the payload is chosen from the caller's role on the server
dashboardRouter.get('/', handle((req) => dashboardService.forCaller(caller(req))));
