import { asyncHandler } from '../../utils/asyncHandler.js';
import { getRequestContext } from '../../utils/requestContext.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import { guestService } from './guest.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const ctx = getRequestContext;

export const create = asyncHandler(async (req, res) =>
  sendCreated(res, { message: 'Guest created', data: { guest: await guestService.create(caller(req), req.body, ctx(req)) } }));

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await guestService.list(caller(req), req.query);
  return sendSuccess(res, { data: items, meta });
});

export const get = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { guest: await guestService.get(caller(req), req.params.id, req.query, ctx(req)) } }));

export const update = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Guest updated', data: { guest: await guestService.update(caller(req), req.params.id, req.body, ctx(req)) } }));

export const remove = asyncHandler(async (req, res) => {
  await guestService.remove(caller(req), req.params.id, ctx(req));
  return sendSuccess(res, { message: 'Guest deleted' });
});
