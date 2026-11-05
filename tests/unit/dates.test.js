import {
  isValidDateKey, addDaysToKey, nightKeys, toLocalDateKey, localToUtc, startOfLocalDay, monthRangeUtc, isValidTimeZone,
} from '../../src/utils/dates.js';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';

describe('dates', () => {
  test('validates date keys strictly', () => {
    expect(isValidDateKey('2026-02-28')).toBe(true);
    expect(isValidDateKey('2026-02-30')).toBe(false);
    expect(isValidDateKey('2026-2-3')).toBe(false);
    expect(isValidDateKey(20260203)).toBe(false);
  });

  test('check-out day is exclusive when listing nights', () => {
    expect(nightKeys('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(nightKeys('2026-11-10', '2026-11-11')).toEqual(['2026-11-10']);
  });

  test('rejects zero or negative stays', () => {
    expect(() => nightKeys('2026-11-10', '2026-11-10')).toThrow(RangeError);
    expect(() => nightKeys('2026-11-11', '2026-11-10')).toThrow(RangeError);
  });

  test('addDaysToKey crosses month and leap-year boundaries', () => {
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('local date differs from UTC date near midnight', () => {
    // 18:00 UTC on the 4th is 01:00 on the 5th in Ho Chi Minh (UTC+7)
    expect(toLocalDateKey(new Date('2026-11-04T18:00:00Z'), HCM)).toBe('2026-11-05');
    expect(toLocalDateKey(new Date('2026-11-04T18:00:00Z'), 'UTC')).toBe('2026-11-04');
  });

  test('local midnight to UTC (no DST)', () => {
    expect(startOfLocalDay('2026-11-04', HCM).toISOString()).toBe('2026-11-03T17:00:00.000Z');
  });

  test('handles DST transitions (New York, spring forward on 2026-03-08)', () => {
    expect(startOfLocalDay('2026-03-08', NY).toISOString()).toBe('2026-03-08T05:00:00.000Z'); // EST
    expect(startOfLocalDay('2026-03-09', NY).toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT
  });

  test('monthRangeUtc is half-open and timezone-aware', () => {
    const { start, end } = monthRangeUtc(2026, 12, HCM);
    expect(start.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  test('localToUtc with explicit time', () => {
    expect(localToUtc(2026, 11, 4, 14, 0, HCM).toISOString()).toBe('2026-11-04T07:00:00.000Z');
  });

  test('time zone validation', () => {
    expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
