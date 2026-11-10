/** Operational error that the error handler turns into an HTTP response. */
export class ApiError extends Error {
  /**
   * @param {number} statusCode HTTP status
   * @param {string} message Human-readable message (safe to show to clients)
   * @param {string} code Stable machine-readable code, e.g. "ROOM_UNAVAILABLE"
   * @param {Array<{field?: string, message: string}>} errors Optional detail list
   */
  constructor(statusCode, message, code = 'ERROR', errors = []) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', errors) {
    return new ApiError(400, message, code, errors);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }
  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }
  static conflict(message = 'Conflict', code = 'CONFLICT') {
    return new ApiError(409, message, code);
  }
  static unprocessable(message = 'Validation failed', errors = [], code = 'VALIDATION_ERROR') {
    return new ApiError(422, message, code, errors);
  }
  static tooManyRequests(message = 'Too many requests', code = 'TOO_MANY_REQUESTS') {
    return new ApiError(429, message, code);
  }
  static unavailable(message = 'Service unavailable', code = 'SERVICE_UNAVAILABLE') {
    return new ApiError(503, message, code);
  }
}
