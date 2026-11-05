/**
 * Time handling rules:
 *  - Instants are stored as UTC `Date`s.
 *  - Business days ("nights", attendance days, report months) are derived in the HOTEL timezone
 *    and represented as date keys: "YYYY-MM-DD" strings.
 * Never build a night/day from `date.getDate()` or `toISOString().slice(0,10)` of a raw instant.
 */
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const isValidDateKey = (key) => {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const assertKey = (key) => {
  if (!isValidDateKey(key)) throw new TypeError(`Invalid date key "${key}". Expected YYYY-MM-DD.`);
};

const keyToUtcMs = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export const addDaysToKey = (key, days) => {
  assertKey(key);
  return new Date(keyToUtcMs(key) + days * DAY_MS).toISOString().slice(0, 10);
};

/** The local calendar date (in `timeZone`) on which `instant` falls. */
export const toLocalDateKey = (instant, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);

/**
 * Nights occupied by a stay: check-in key inclusive, check-out key exclusive.
 * 10th -> 12th occupies the nights of the 10th and the 11th.
 */
export const nightKeys = (checkInKey, checkOutKey) => {
  assertKey(checkInKey);
  assertKey(checkOutKey);
  if (checkOutKey <= checkInKey) throw new RangeError('Check-out must be after check-in');
  const keys = [];
  for (let k = checkInKey; k < checkOutKey; k = addDaysToKey(k, 1)) keys.push(k);
  return keys;
};

const offsetMs = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/** The UTC instant at which the wall clock in `timeZone` reads the given local date/time. */
export const localToUtc = (year, month, day, hour, minute, timeZone) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), timeZone);
  let utc = guess - first;
  const second = offsetMs(new Date(utc), timeZone);
  if (second !== first) utc = guess - second; // crossed a DST boundary
  return new Date(utc);
};

/** UTC instant of local midnight at the start of the given date key. */
export const startOfLocalDay = (key, timeZone) => {
  assertKey(key);
  const [y, m, d] = key.split('-').map(Number);
  return localToUtc(y, m, d, 0, 0, timeZone);
};

/** Half-open UTC range [start, end) covering a whole local calendar month. month: 1-12. */
export const monthRangeUtc = (year, month, timeZone) => {
  const start = localToUtc(year, month, 1, 0, 0, timeZone);
  const end = month === 12 ? localToUtc(year + 1, 1, 1, 0, 0, timeZone) : localToUtc(year, month + 1, 1, 0, 0, timeZone);
  return { start, end };
};

export const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};
