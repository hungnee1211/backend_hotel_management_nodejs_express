import { allocate, calculateInvoice, deriveStatus } from '../../src/modules/billing/invoice.calculator.js';

const ch = (category, amountMinor, description = category) => ({ _id: `${category}${amountMinor}`, category, description, quantity: 1, unitPriceMinor: amountMinor, amountMinor });
const VAT = { code: 'VAT', name: 'VAT', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], isServiceCharge: false };

describe('allocate', () => {
  test('splits exactly with largest remainder', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [3, 0, 7])).toEqual([3, 0, 7]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    for (const total of [1, 7, 99, 1_000_001]) expect(allocate(total, [3, 5, 11]).reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('calculateInvoice', () => {
  test('room + F&B + service with 10% VAT: grand = subtotal + tax', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 2_000_000), ch('FOOD_AND_BEVERAGE', 300_000), ch('ADDITIONAL_SERVICE', 200_000)], taxRules: [VAT] });
    expect(r).toMatchObject({ subtotalMinor: 2_500_000, discountTotalMinor: 0, taxTotalMinor: 250_000, grandTotalMinor: 2_750_000 });
    expect(r.taxBreakdown.map((t) => [t.category, t.baseMinor, t.taxMinor])).toEqual([['ROOM', 2_000_000, 200_000], ['FOOD_AND_BEVERAGE', 300_000, 30_000], ['ADDITIONAL_SERVICE', 200_000, 20_000]]);
  });

  test('discounts reduce the base BEFORE tax, spread proportionally', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 1_000_000), ch('FOOD_AND_BEVERAGE', 1_000_000), ch('DISCOUNT', -200_000)], taxRules: [VAT] });
    expect(r.discountTotalMinor).toBe(200_000);
    expect(r.taxBreakdown.map((t) => t.baseMinor)).toEqual([900_000, 900_000]);
    expect(r.taxTotalMinor).toBe(180_000);
    expect(r.grandTotalMinor).toBe(2_000_000 - 200_000 + 180_000);
  });

  test('a discount can never exceed the subtotal', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 100_000), ch('DISCOUNT', -999_999)], taxRules: [VAT] });
    expect(r.discountTotalMinor).toBe(100_000);
    expect(r.taxTotalMinor).toBe(0);
    expect(r.grandTotalMinor).toBe(0);
  });

  test('surcharges are added after discounts and are taxable', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 1_000_000), ch('SURCHARGE', 100_000), ch('DISCOUNT', -100_000)], taxRules: [VAT] });
    expect(r.surchargeTotalMinor).toBe(100_000);
    expect(r.taxBreakdown.find((t) => t.category === 'SURCHARGE').taxMinor).toBe(10_000);
    expect(r.grandTotalMinor).toBe(1_000_000 - 100_000 + 100_000 + 90_000 + 10_000);
  });

  test('service charge is computed on the discounted subtotal and taxed with surcharges', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 1_000_000), ch('DISCOUNT', -100_000)], taxRules: [VAT], serviceChargeBps: 500 });
    expect(r.serviceChargeMinor).toBe(45_000); // 5% of 900,000
    expect(r.taxBreakdown.find((t) => t.category === 'SURCHARGE').baseMinor).toBe(45_000);
    expect(r.grandTotalMinor).toBe(1_000_000 - 100_000 + 45_000 + 90_000 + 4_500);
  });

  test('tax lines are rounded half-up individually and the breakdown reconciles to the total', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 5), ch('FOOD_AND_BEVERAGE', 5), ch('ADDITIONAL_SERVICE', 5)], taxRules: [VAT] });
    expect(r.taxBreakdown.map((t) => t.taxMinor)).toEqual([1, 1, 1]); // 0.5 -> 1 each
    expect(r.taxTotalMinor).toBe(r.taxBreakdown.reduce((a, t) => a + t.taxMinor, 0));
  });

  test('multiple rules and per-category applicability', () => {
    const rules = [{ ...VAT, appliesTo: ['ROOM'], rateBps: 800 }, { code: 'TOUR', name: 'Tourism', rateBps: 200, appliesTo: ['ROOM', 'ADDITIONAL_SERVICE'], isServiceCharge: false }];
    const r = calculateInvoice({ charges: [ch('ROOM', 1_000_000), ch('FOOD_AND_BEVERAGE', 500_000), ch('ADDITIONAL_SERVICE', 100_000)], taxRules: rules });
    expect(r.taxBreakdown.map((t) => `${t.code}:${t.category}:${t.taxMinor}`)).toEqual(['VAT:ROOM:80000', 'TOUR:ROOM:20000', 'TOUR:ADDITIONAL_SERVICE:2000']);
    expect(r.taxTotalMinor).toBe(102_000);
  });

  test('no charges gives an all-zero invoice; no tax rules means no tax', () => {
    expect(calculateInvoice({ charges: [], taxRules: [VAT] }).grandTotalMinor).toBe(0);
    expect(calculateInvoice({ charges: [ch('ROOM', 1000)] }).grandTotalMinor).toBe(1000);
  });

  test('stays exact for very large amounts', () => {
    const r = calculateInvoice({ charges: [ch('ROOM', 9_000_000_000_000)], taxRules: [VAT] });
    expect(r.taxTotalMinor).toBe(900_000_000_000);
    expect(r.grandTotalMinor).toBe(9_900_000_000_000);
  });
});

describe('deriveStatus', () => {
  const base = { grandTotalMinor: 1000, adjustmentsTotalMinor: 0, paidMinor: 0, dueAt: new Date(Date.now() + 1e6) };
  test('follows the money', () => {
    expect(deriveStatus({ ...base, status: 'ISSUED' })).toBe('ISSUED');
    expect(deriveStatus({ ...base, status: 'ISSUED', paidMinor: 400 })).toBe('PARTIALLY_PAID');
    expect(deriveStatus({ ...base, status: 'ISSUED', paidMinor: 1000 })).toBe('PAID');
    expect(deriveStatus({ ...base, status: 'ISSUED', adjustmentsTotalMinor: -1000 })).toBe('PAID');
    expect(deriveStatus({ ...base, status: 'ISSUED', dueAt: new Date(Date.now() - 1e3) })).toBe('OVERDUE');
  });
  test('DRAFT and VOID are explicit and never derived', () => {
    expect(deriveStatus({ ...base, status: 'DRAFT', paidMinor: 1000 })).toBe('DRAFT');
    expect(deriveStatus({ ...base, status: 'VOID', paidMinor: 1000 })).toBe('VOID');
  });
});
