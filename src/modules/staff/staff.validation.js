import Joi from 'joi';
import { DEPARTMENTS, USER_STATUS } from '../../constants/index.js';
import { ALL_PERMISSIONS } from '../../constants/permissions.js';
import { email, fullName, idParams, objectId, pagination, password, phone } from '../../utils/joi-rules.js';

const permissionList = Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).max(50).unique();
const permissionOverrides = Joi.object({ grant: permissionList, revoke: permissionList }).min(1);
const department = Joi.string().valid(...Object.values(DEPARTMENTS));
const jobTitle = Joi.string().trim().max(120);

export const staffValidation = {
  params: { params: idParams },
  create: {
    body: Joi.object({
      fullName: fullName.required(),
      email,
      phone,
      password: password.required(),
      department: department.required(),
      jobTitle,
      managerId: objectId,
      hiredAt: Joi.date().iso().max('now'),
      permissionOverrides,
    }).or('email', 'phone'),
  },
  list: {
    query: Joi.object({
      ...pagination,
      department,
      status: Joi.string().valid(...Object.values(USER_STATUS)),
      managerId: objectId,
      sortBy: Joi.string().valid('createdAt', 'fullName', 'department', 'employeeCode'),
    }),
  },
  update: {
    params: idParams,
    body: Joi.object({
      fullName,
      department,
      jobTitle: jobTitle.allow(null),
      managerId: objectId.allow(null),
      hiredAt: Joi.date().iso().max('now'),
      permissionOverrides,
    }).min(1),
  },
  createManager: {
    body: Joi.object({ fullName: fullName.required(), email, phone, password: password.required() }).or('email', 'phone'),
  },
  transfer: { params: idParams, body: Joi.object({ toManagerId: objectId.required() }) },
};
