import { parseDuration } from '../../src/utils/duration.js';

test('parses durations', () => {
  expect(parseDuration('15m')).toBe(900_000);
  expect(parseDuration('7d')).toBe(604_800_000);
  expect(parseDuration('30s')).toBe(30_000);
  expect(() => parseDuration('soon')).toThrow(TypeError);
});
