import { ApiError } from '../utils/ApiError.js';

/**
 * validate({ body, query, params }) with Joi schemas.
 * Unknown keys are stripped (mass-assignment protection) and values are converted to their schema types.
 */
export const validate = (schemas) => (req, _res, next) => {
  const errors = [];
  for (const part of ['params', 'query', 'body']) {
    const schema = schemas[part];
    if (!schema) continue;
    const { value, error } = schema.validate(req[part], { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
      errors.push(...error.details.map((d) => ({ field: `${part}.${d.path.join('.')}`.replace(/\.$/, ''), message: d.message.replace(/"/g, '') })));
    } else {
      req[part] = value;
    }
  }
  return errors.length ? next(ApiError.unprocessable('Validation failed', errors)) : next();
};
