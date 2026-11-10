import { CHARGE_CATEGORIES as C } from '../../constants/index.js';
import { add, percentBps, sum } from '../../utils/money.js';

/** Splits `total` across `weights` proportionally, exactly (largest-remainder), using BigInt. */
export const allocate = (total, weights) => {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!sumW || !total) return weights.map(() => 0);
  const T = BigInt(total); const S = BigInt(sumW);
  const base = weights.map((w) => (T * BigInt(w)) / S);
  const frac = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % S }));
  let left = Number(T - base.reduce((a, b) => a + b, 0n));
  frac.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (const { i } of frac) { if (left <= 0) break; out[i] += 1; left -= 1; }
  return out;
};

const GOODS = [C.ROOM, C.FOOD_AND_BEVERAGE, C.ADDITIONAL_SERVICE];

/**
 * Pure invoice maths. ORDER OF OPERATIONS (fixed, documented in the README):
 *   1. subtotal  = ROOM + F&B + SERVICE charges;  surcharges and discounts are totalled separately
 *   2. discounts reduce the subtotal BEFORE tax, spread proportionally over ROOM/F&B/SERVICE
 *      (a discount can never exceed the subtotal)
 *   3. service charge (a % in basis points) is computed on the discounted subtotal
 *   4. tax is computed per (rule x category) on the net base of that category; the service charge is
 *      taxed together with SURCHARGE. Each tax line is rounded half-up on its own, and the total is
 *      the sum of the rounded lines, so the breakdown always reconciles exactly.
 *   5. grandTotal = subtotal - discounts + surcharges + serviceCharge + tax
 * Everything is integer minor units.
 */
export const calculateInvoice = ({ charges, taxRules = [], serviceChargeBps = 0 }) => {
  const cat = (c) => charges.filter((x) => x.category === c);
  const total = (list) => sum(list.map((x) => x.amountMinor));
  const gross = { [C.ROOM]: total(cat(C.ROOM)), [C.FOOD_AND_BEVERAGE]: total(cat(C.FOOD_AND_BEVERAGE)), [C.ADDITIONAL_SERVICE]: total(cat(C.ADDITIONAL_SERVICE)) };
  const subtotalMinor = sum(Object.values(gross));
  const surchargeTotalMinor = total(cat(C.SURCHARGE));
  const discountTotalMinor = Math.min(Math.abs(total(cat(C.DISCOUNT))), subtotalMinor);

  const shares = allocate(discountTotalMinor, GOODS.map((g) => gross[g]));
  const net = Object.fromEntries(GOODS.map((g, i) => [g, gross[g] - shares[i]]));
  const netGoods = sum(Object.values(net));

  const serviceRules = taxRules.filter((r) => r.isServiceCharge);
  const serviceChargeMinor = sum([serviceChargeBps ? percentBps(netGoods, serviceChargeBps) : 0, ...serviceRules.map((r) => percentBps(netGoods, r.rateBps))]);

  const taxBase = { ...net, [C.SURCHARGE]: add(surchargeTotalMinor, serviceChargeMinor) };
  const taxBreakdown = [];
  for (const rule of taxRules.filter((r) => !r.isServiceCharge)) {
    for (const category of rule.appliesTo) {
      const baseMinor = taxBase[category] ?? 0;
      if (baseMinor > 0) taxBreakdown.push({ code: rule.code, name: rule.name, rateBps: rule.rateBps, category, baseMinor, taxMinor: percentBps(baseMinor, rule.rateBps) });
    }
  }
  const taxTotalMinor = sum(taxBreakdown.map((t) => t.taxMinor));
  const grandTotalMinor = sum([subtotalMinor, -discountTotalMinor, surchargeTotalMinor, serviceChargeMinor, taxTotalMinor]);

  return {
    lineItems: charges.map((c) => ({ chargeId: c._id ?? c.id, category: c.category, description: c.description, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor, amountMinor: c.amountMinor })),
    subtotalMinor, discountTotalMinor, surchargeTotalMinor, serviceChargeMinor, taxTotalMinor, grandTotalMinor, taxBreakdown,
  };
};

/** Invoice status derived from money, never set by hand. DRAFT and VOID are explicit states and never derived. */
export const deriveStatus = ({ status, grandTotalMinor, adjustmentsTotalMinor = 0, paidMinor, dueAt }, now = new Date()) => {
  if (status === 'DRAFT' || status === 'VOID') return status;
  const outstanding = grandTotalMinor + adjustmentsTotalMinor - paidMinor;
  if (outstanding <= 0) return grandTotalMinor + adjustmentsTotalMinor <= 0 && paidMinor === 0 && status === 'REFUNDED' ? 'REFUNDED' : 'PAID';
  if (paidMinor > 0) return 'PARTIALLY_PAID';
  return dueAt && dueAt < now ? 'OVERDUE' : 'ISSUED';
};
