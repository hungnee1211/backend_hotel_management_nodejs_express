/** Pure pricing helpers. All amounts are integer minor units. */
export const nightlyRate = (roomType, dateKey) => {
  const seasonal = (roomType.rates ?? []).find((r) => r.from <= dateKey && dateKey <= r.to);
  return seasonal ? seasonal.priceMinor : roomType.basePriceMinor;
};

/** [{ date, priceMinor }] for each night of a stay. The price is frozen into the booking at creation time. */
export const quoteNights = (roomType, nights) => nights.map((date) => ({ date, priceMinor: nightlyRate(roomType, date) }));

export const sumNights = (nightly) => nightly.reduce((acc, n) => acc + n.priceMinor, 0);
