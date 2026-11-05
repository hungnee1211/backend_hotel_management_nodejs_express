import Joi from 'joi';
import { validate } from '../../src/middlewares/validate.js';

const run = (schemas, req) => {
  let result;
  validate(schemas)(req, {}, (err) => { result = err; });
  return result;
};

describe('validate middleware', () => {
  const schemas = { body: Joi.object({ name: Joi.string().required(), qty: Joi.number().integer() }) };

  test('strips unknown keys (mass-assignment protection) and converts types', () => {
    const req = { body: { name: 'x', qty: '3', role: 'ADMIN' } };
    expect(run(schemas, req)).toBeUndefined();
    expect(req.body).toEqual({ name: 'x', qty: 3 });
  });

  test('returns a 422 ApiError listing every problem', () => {
    const err = run(schemas, { body: { qty: 'abc' } });
    expect(err.statusCode).toBe(422);
    expect(err.errors.map((e) => e.field).sort()).toEqual(['body.name', 'body.qty']);
  });
});
