import { asyncHandler } from './asyncHandler.js';
import { sendSuccess } from './response.js';

/**
 * Thin controller adapter: `handle(req => service.doThing(...), { status, message })`.
 * A service result of the form { items, meta } becomes a paginated response; anything else is `data`.
 */
export const handle = (fn, { status = 200, message } = {}) =>
  asyncHandler(async (req, res) => {
    const result = await fn(req);
    if (result && Array.isArray(result.items) && result.meta) return sendSuccess(res, { statusCode: status, message, data: result.items, meta: result.meta });
    return sendSuccess(res, { statusCode: status, message, data: result ?? null });
  });
