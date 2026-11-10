import Joi from 'joi';
import { ROLES, USER_STATUS } from '../../constants/index.js';
import { fullName, idParams, pagination } from '../../utils/joi-rules.js';

export const userValidation = {
  params: { params: idParams },
  list: {
    query: Joi.object({
      ...pagination,
      role: Joi.string().valid(...Object.values(ROLES)),
      status: Joi.string().valid(...Object.values(USER_STATUS)),
      isVerified: Joi.boolean(),
      sortBy: Joi.string().valid('createdAt', 'fullName', 'email', 'role', 'status'),
    }),
  },
  update: {
    params: idParams,
    body: Joi.object({
      fullName,
      avatar: Joi.string().uri({ scheme: ['https'] }).max(2048).allow(null),
    }).min(1),
  },
};
