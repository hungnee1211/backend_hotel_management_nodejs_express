import Joi from 'joi';
import { HOUSEKEEPING_STATUS, ROOM_STATUS } from '../../constants/index.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
const amenities = Joi.array().items(Joi.string().trim().max(40)).max(50).unique();
const csv = Joi.string().custom((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
const dateKey = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'must be YYYY-MM-DD' });
const body = (req) => ({
  roomNumber: req ? Joi.string().trim().max(20).required() : Joi.string().trim().max(20),
  floor: req ? Joi.number().integer().min(-5).max(200).required() : Joi.number().integer().min(-5).max(200),
  roomTypeId: req ? objectId.required() : objectId, amenities, notes: Joi.string().trim().max(1000).allow(''),
});
export const roomValidation = {
  list: { query: Joi.object({ ...pagination, roomTypeId: objectId, floor: Joi.number().integer(), status: Joi.string().valid(...Object.values(ROOM_STATUS)), housekeepingStatus: Joi.string().valid(...Object.values(HOUSEKEEPING_STATUS)), capacity: Joi.number().integer().min(1), minPrice: Joi.number().integer().min(0), maxPrice: Joi.number().integer().min(0), amenities: csv, sortBy: Joi.string().valid('roomNumber', 'floor', 'createdAt') }) },
  availability: { query: Joi.object({ checkIn: dateKey.required(), checkOut: dateKey.required(), adults: Joi.number().integer().min(1).max(20).default(1), children: Joi.number().integer().min(0).max(20).default(0), roomTypeId: objectId, minPrice: Joi.number().integer().min(0), maxPrice: Joi.number().integer().min(0), amenities: csv, limit: Joi.number().integer().min(1).max(200).default(100) }) },
  params: { params: idParams },
  create: { body: Joi.object(body(true)) },
  update: { params: idParams, body: Joi.object(body(false)).min(1) },
  status: { params: idParams, body: Joi.object({ status: Joi.string().valid(ROOM_STATUS.AVAILABLE, ROOM_STATUS.MAINTENANCE, ROOM_STATUS.OUT_OF_SERVICE).required(), reason: Joi.string().max(300) }) },
};
