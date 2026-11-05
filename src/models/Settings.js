import mongoose from 'mongoose';
import { isValidTimeZone } from '../utils/dates.js';

const { Schema } = mongoose;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Singleton document (key = "hotel") holding hotel-wide configuration.
 * Defaults below are placeholders for decisions still open with the hotel (cancellation policy, deposits).
 */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'hotel', immutable: true },
    hotelName: { type: String, default: 'Hotel', trim: true, maxlength: 120 },
    timezone: {
      type: String,
      required: true,
      validate: { validator: isValidTimeZone, message: 'Invalid IANA time zone' },
    },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    checkInTime: { type: String, default: '14:00', match: HHMM },
    checkOutTime: { type: String, default: '12:00', match: HHMM },
    reservation: {
      holdMinutes: { type: Number, default: 15, min: 1, max: 1440 },
      maxNightsPerBooking: { type: Number, default: 30, min: 1 },
      maxAdvanceBookingDays: { type: Number, default: 365, min: 1 },
    },
    cancellationPolicy: {
      freeCancellationHoursBeforeCheckIn: { type: Number, default: 48, min: 0 },
      penaltyNights: { type: Number, default: 1, min: 0 },
    },
    depositBps: { type: Number, default: 0, min: 0, max: 10000 },
    serviceChargeBps: { type: Number, default: 0, min: 0, max: 10000 },
    allowCheckoutWithOutstandingBalance: { type: Boolean, default: false },
  },
  { timestamps: true },
);

settingsSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('Settings', settingsSchema);
