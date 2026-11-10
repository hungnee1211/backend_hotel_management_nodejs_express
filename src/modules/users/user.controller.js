import { asyncHandler } from '../../utils/asyncHandler.js';
import { getRequestContext } from '../../utils/requestContext.js';
import { sendSuccess } from '../../utils/response.js';
import { userService } from './user.service.js';

const ctx = getRequestContext;

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await userService.list(req.user, req.query);
  return sendSuccess(res, { data: items.map((u) => u.toJSON()), meta });
});

export const get = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { user: (await userService.getById(req.user, req.params.id)).toJSON() } }));

export const update = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'User updated', data: { user: (await userService.update(req.user, req.params.id, req.body, ctx(req))).toJSON() } }));

export const deactivate = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'User deactivated', data: { user: (await userService.deactivate(req.user, req.params.id, ctx(req))).toJSON() } }));

export const reactivate = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'User reactivated', data: { user: (await userService.reactivate(req.user, req.params.id, ctx(req))).toJSON() } }));

export const remove = asyncHandler(async (req, res) => {
  await userService.softDelete(req.user, req.params.id, ctx(req));
  return sendSuccess(res, { message: 'User deleted' });
});
