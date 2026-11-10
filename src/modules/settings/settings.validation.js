import Joi from 'joi';
import { TAXABLE_CATEGORIES } from '../../constants/index.js';
import { idParams } from '../../utils/joi-rules.js';
const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);
const int = (min = 0, max) => { let s = Joi.number().integer().min(min); if (max !== undefined) s = s.max(max); return s; };
export const settingsValidation = {
  update: { body: Joi.object({
    hotelName: Joi.string().trim().max(120), checkInTime: hhmm, checkOutTime: hhmm,
    reservation: Joi.object({ holdMinutes: int(1, 1440), maxNightsPerBooking: int(1, 365), maxAdvanceBookingDays: int(1, 1000) }).min(1),
    cancellationPolicy: Joi.object({ freeCancellationHoursBeforeCheckIn: int(0), penaltyNights: int(0) }).min(1),
    housekeeping: Joi.object({ requireInspection: Joi.boolean() }).min(1),
    attendance: Joi.object({ lateGraceMinutes: int(0), earlyLeaveGraceMinutes: int(0), earlyCheckInMinutes: int(0) }).min(1),
    billing: Joi.object({ managerApprovalLimitMinor: int(0), invoiceDueDays: int(0, 365) }).min(1),
    depositBps: int(0, 10000), serviceChargeBps: int(0, 10000), allowCheckoutWithOutstandingBalance: Joi.boolean(),
  }).min(1) },
  createTaxRule: { body: Joi.object({
    code: Joi.string().trim().uppercase().max(20).required(), name: Joi.string().trim().max(80).required(),
    rateBps: int(0, 100000).required(), appliesTo: Joi.array().items(Joi.string().valid(...TAXABLE_CATEGORIES)).min(1).unique().required(),
    isServiceCharge: Joi.boolean(), effectiveFrom: Joi.date().iso().required(), effectiveTo: Joi.date().iso().allow(null),
  }) },
  updateTaxRule: { params: idParams, body: Joi.object({ name: Joi.string().trim().max(80), rateBps: int(0, 100000), appliesTo: Joi.array().items(Joi.string().valid(...TAXABLE_CATEGORIES)).min(1).unique(), effectiveTo: Joi.date().iso().allow(null), isActive: Joi.boolean() }).min(1) },
};
