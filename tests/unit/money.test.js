import { add, sub, sum, mulInt, percentBps, formatMoney, assertMinor } from '../../src/utils/money.js';

describe('money', () => {
  test('adds integer minor units exactly', () => {
    expect(add(100000, 250000)).toBe(350000);
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(sub(10, 25)).toBe(-15);
  });

  test('rejects floats and non-numbers (no float arithmetic on money)', () => {
    expect(() => add(0.1, 0.2)).toThrow(TypeError);
    expect(() => assertMinor('100')).toThrow(TypeError);
    expect(() => mulInt(100, 1.5)).toThrow(TypeError);
  });

  test('multiplies by whole quantities', () => {
    expect(mulInt(850000, 3)).toBe(2550000);
  });

  test('percentBps: 10% VAT', () => {
    expect(percentBps(1_000_000, 1000)).toBe(100_000);
  });

  test('percentBps rounds half up (away from zero)', () => {
    expect(percentBps(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentBps(4, 1000)).toBe(0); // 0.4 -> 0
    expect(percentBps(-5, 1000)).toBe(-1); // symmetric for credits
  });

  test('percentBps stays exact for very large amounts', () => {
    expect(percentBps(10_000_000_000_000, 800)).toBe(800_000_000_000);
  });

  test('throws instead of silently losing precision', () => {
    expect(() => add(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(() => percentBps(Number.MAX_SAFE_INTEGER, 20000)).toThrow(RangeError);
  });

  test('formatMoney respects currency exponent', () => {
    expect(formatMoney(150000, 'VND')).toMatch(/150,000/);
    expect(formatMoney(1234, 'USD')).toBe('$12.34');
  });
});
