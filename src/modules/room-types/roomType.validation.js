import Joi from 'joi';
import { idParams, pagination } from '../../utils/joi-rules.js';
const dateKey = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const money = Joi.number().integer().min(0);
const rate = Joi.object({ name: Joi.string().trim().max(60), from: dateKey.required(), to: dateKey.required(), priceMinor: money.required() });
const body = (req) => ({
  name: req ? Joi.string().trim().max(80).required() : Joi.string().trim().max(80), description: Joi.string().trim().max(2000).allow(''),
  capacity: req ? Joi.number().integer().min(1).max(20).required() : Joi.number().integer().min(1).max(20),
  bedConfiguration: Joi.string().trim().max(120), amenities: Joi.array().items(Joi.string().trim().max(40)).max(50).unique(),
  images: Joi.array().items(Joi.string().uri({ scheme: ['https'] })).max(20),
  basePriceMinor: req ? money.required() : money, rates: Joi.array().items(rate).max(60), status: Joi.string().valid('ACTIVE', 'INACTIVE'),
});
export const roomTypeValidation = {
  list: { query: Joi.object({ ...pagination, status: Joi.string().valid('ACTIVE', 'INACTIVE'), sortBy: Joi.string().valid('name', 'basePriceMinor', 'capacity', 'createdAt') }) },
  params: { params: idParams },
  create: { body: Joi.object(body(true)) },
  update: { params: idParams, body: Joi.object(body(false)).min(1) },
};
