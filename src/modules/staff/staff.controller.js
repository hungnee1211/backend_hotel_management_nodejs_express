import { asyncHandler } from '../../utils/asyncHandler.js';
import { getRequestContext } from '../../utils/requestContext.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import { staffService } from './staff.service.js';
import { userService } from '../users/user.service.js';

const ctx = getRequestContext;

export const create = asyncHandler(async (req, res) =>
  sendCreated(res, { message: 'Staff member created', data: { staff: await staffService.create(req.user, req.body, ctx(req)) } }));

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await staffService.list(req.user, req.query);
  return sendSuccess(res, { data: items, meta });
});

export const get = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { staff: await staffService.get(req.user, req.params.id) } }));

/** The logged-in staff member's own profile. */
export const me = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { staff: await staffService.get(req.user, String(req.user._id)) } }));

export const update = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Staff member updated', data: { staff: await staffService.update(req.user, req.params.id, req.body, ctx(req)) } }));

export const permissions = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: await staffService.getPermissions(req.user, req.params.id) }));

export const createManager = asyncHandler(async (req, res) =>
  sendCreated(res, { message: 'Manager created', data: { user: (await userService.createManager(req.user, req.body, ctx(req))).toJSON() } }));

export const transferStaff = asyncHandler(async (req, res) => {
  const result = await staffService.transferStaff(req.user, req.params.id, req.body.toManagerId, ctx(req));
  return sendSuccess(res, { message: `${result.transferred} staff member(s) reassigned`, data: result });
});
