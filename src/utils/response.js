/** Every success response has the shape { success: true, message, data, meta? }. */
export const sendSuccess = (res, { statusCode = 200, message = 'Operation completed successfully', data = null, meta } = {}) => {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
};

export const sendCreated = (res, { message = 'Created successfully', ...rest } = {}) =>
  sendSuccess(res, { statusCode: 201, message, ...rest });
