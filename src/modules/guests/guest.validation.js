import Joi from 'joi';
import { GUEST_ID_TYPES } from '../../constants/index.js';
import { email, fullName, idParams, objectId, pagination, phone } from '../../utils/joi-rules.js';

const identification = Joi.object({
  type: Joi.string().valid(...Object.values(GUEST_ID_TYPES)).required(),
  number: Joi.string().trim().pattern(/^[A-Za-z0-9][A-Za-z0-9 -]{2,30}[A-Za-z0-9]$/).required()
    .messages({ 'string.pattern.base': 'must be 4-32 letters, digits, spaces or dashes' }),
});

const address = Joi.object({
  line1: Joi.string().trim().max(200),
  city: Joi.string().trim().max(100),
  state: Joi.string().trim().max(100),
  country: Joi.string().trim().max(100),
  postalCode: Joi.string().trim().max(20),
}).min(1);

const body = (required) => ({
  fullName: required ? fullName.required() : fullName,
  email,
  phone,
  nationality: Joi.string().trim().max(60),
  identification,
  address,
  notes: Joi.string().trim().max(1000).allow(''),
  userId: objectId, // link to a customer account; privileged roles only (checked in the service)
});

export const guestValidation = {
  params: { params: idParams },
  create: { body: Joi.object(body(true)) },
  update: {
    params: idParams,
    body: Joi.object({ ...body(false), identification: identification.allow(null), userId: objectId.allow(null) }).min(1),
  },
  get: {
    params: idParams,
    query: Joi.object({ revealIdentification: Joi.boolean().default(false) }),
  },
  list: {
    query: Joi.object({
      ...pagination,
      email,
      phone,
      idNumber: Joi.string().trim().max(40),
      sortBy: Joi.string().valid('createdAt', 'fullName'),
    }),
  },
};
