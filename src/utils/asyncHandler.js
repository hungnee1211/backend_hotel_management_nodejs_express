/** Forwards rejected promises from async route handlers to Express's error pipeline. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
