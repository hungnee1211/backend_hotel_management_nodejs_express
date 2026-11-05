import { rejectUnsafeInput } from '../../src/middlewares/sanitize.js';

const run = (req) => {
  let result;
  rejectUnsafeInput({ body: {}, query: {}, params: {}, ...req }, {}, (err) => { result = err; });
  return result;
};

describe('rejectUnsafeInput', () => {
  test('allows normal input', () => {
    expect(run({ body: { email: 'a@b.com', nested: { list: [1, 2, { ok: true }] } } })).toBeUndefined();
  });
  test('rejects operator keys at any depth', () => {
    expect(run({ body: { email: { $ne: null } } }).code).toBe('INVALID_INPUT');
    expect(run({ body: { a: [{ b: { $gt: '' } }] } }).code).toBe('INVALID_INPUT');
    expect(run({ query: { $where: '1' } }).code).toBe('INVALID_INPUT');
  });
  test('rejects dotted and prototype-pollution keys', () => {
    expect(run({ body: { 'a.b': 1 } }).code).toBe('INVALID_INPUT');
    expect(run({ body: JSON.parse('{"__proto__": {"x": 1}}') }).code).toBe('INVALID_INPUT');
  });
});
