/**
 * Money is ALWAYS an integer count of the currency's minor unit
 * (VND has no minor unit, so 150000 means 150,000 VND; USD 12.34 is 1234).
 * Nothing in the codebase should add, multiply or compare money as floats.
 */
const EXPONENTS = { VND: 0, JPY: 0, KRW: 0, USD: 2, EUR: 2, GBP: 2, SGD: 2, THB: 2 };

export const currencyExponent = (currency) => EXPONENTS[currency] ?? 2;

export const assertMinor = (value, label = 'amount') => {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer in minor currency units`);
  return value;
};

const checked = (value) => {
  if (!Number.isSafeInteger(value)) throw new RangeError('Monetary result exceeds the safe integer range');
  return value;
};

export const add = (a, b) => checked(assertMinor(a) + assertMinor(b));
export const sub = (a, b) => checked(assertMinor(a) - assertMinor(b));
export const sum = (values) => values.reduce((acc, v) => add(acc, v), 0);

/** Unit price × whole quantity. Fractional quantities (e.g. 1.5 hours) are not supported; use a smaller unit. */
export const mulInt = (amount, quantity) => {
  assertMinor(amount);
  assertMinor(quantity, 'quantity');
  return checked(amount * quantity);
};

/**
 * amount × rate, where rate is in basis points (1% = 100 bps, 10% = 1000 bps).
 * Rounds half away from zero. Computed with BigInt so large amounts never lose precision.
 */
export const percentBps = (amount, bps) => {
  assertMinor(amount);
  assertMinor(bps, 'bps');
  const numerator = BigInt(amount) * BigInt(bps);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude + 5000n) / 10000n;
  const result = negative ? -rounded : rounded;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Monetary result exceeds the safe integer range');
  }
  return Number(result);
};

/** Display only. Never feed the output back into arithmetic. */
export const formatMoney = (amount, currency, locale = 'en-US') => {
  assertMinor(amount);
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amount / 10 ** exponent);
};
