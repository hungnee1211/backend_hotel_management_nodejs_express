import { ApiError } from '../../utils/ApiError.js';
import { addDaysToKey, nightKeys, startOfLocalDay, toLocalDateKey } from '../../utils/dates.js';

const pad = (n) => String(n).padStart(2, '0');
const nextMonthKey = (y, m) => (m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`);

/**
 * Turns report parameters into one half-open range [fromKey, toKey) in HOTEL-LOCAL dates, plus the matching UTC instants.
 *   ?period=month&year=2026&month=11 (default: current month) | quarter | year | ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive)
 */
export const resolveRange = (q, tz, now = new Date()) => {
  const [ty, tm] = toLocalDateKey(now, tz).split('-').map(Number);
  let fromKey; let toKey; let label;
  if (q.from || q.to) {
    if (!(q.from && q.to)) throw ApiError.unprocessable('Provide both from and to', [{ field: 'query.to', message: 'required' }], 'INVALID_RANGE');
    fromKey = q.from; toKey = addDaysToKey(q.to, 1); label = `${q.from}..${q.to}`;
  } else {
    const period = q.period ?? 'month'; const year = q.year ?? ty;
    if (period === 'year') { fromKey = `${year}-01-01`; toKey = `${year + 1}-01-01`; label = String(year); }
    else if (period === 'quarter') { const qt = q.quarter ?? Math.ceil(tm / 3); const m0 = (qt - 1) * 3 + 1; fromKey = `${year}-${pad(m0)}-01`; toKey = nextMonthKey(year, m0 + 2); label = `${year}-Q${qt}`; }
    else { const month = q.month ?? tm; fromKey = `${year}-${pad(month)}-01`; toKey = nextMonthKey(year, month); label = `${year}-${pad(month)}`; }
  }
  if (toKey <= fromKey) throw ApiError.unprocessable('The range must end after it starts', [], 'INVALID_RANGE');
  const days = nightKeys(fromKey, toKey).length;
  if (days > 732) throw ApiError.unprocessable('The range is too long (max 2 years)', [], 'RANGE_TOO_LONG');
  return { fromKey, toKey, days, label, start: startOfLocalDay(fromKey, tz), end: startOfLocalDay(toKey, tz) };
};

/** The period of equal length immediately before `range` (for "vs previous period" comparisons). */
export const previousRange = (range, tz) => {
  const fromKey = addDaysToKey(range.fromKey, -range.days);
  return { fromKey, toKey: range.fromKey, days: range.days, label: `${fromKey}..${addDaysToKey(range.fromKey, -1)}`, start: startOfLocalDay(fromKey, tz), end: range.start };
};
