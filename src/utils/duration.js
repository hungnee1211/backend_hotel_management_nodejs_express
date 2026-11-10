const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "15m" -> 900000. Accepts a number followed by ms|s|m|h|d. */
export const parseDuration = (value) => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!match) throw new TypeError(`Invalid duration "${value}". Use forms like 30s, 15m, 7d.`);
  return Number(match[1]) * UNITS[match[2]];
};
