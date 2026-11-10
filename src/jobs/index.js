import { env } from '../config/environment.js';
import { logger } from '../utils/logger.js';
import { attendanceService } from '../modules/attendance/attendance.service.js';
import { bookingService } from '../modules/bookings/booking.service.js';
import { invoiceService } from '../modules/invoices/invoice.service.js';
import { maintenanceService } from '../modules/maintenance/maintenance.service.js';
import { orderService } from '../modules/orders/order.service.js';

const MIN = 60_000;
/**
 * Every job is idempotent (conditional updates / unique keys), so running them on several app instances at once,
 * or running one twice, is harmless. A job that is still running is never started again on the same instance.
 */
const JOBS = [
  ['expire-pending-bookings', 1 * MIN, () => bookingService.processExpired()],
  ['mark-no-shows', 10 * MIN, () => bookingService.processNoShows()],
  ['complete-delivered-orders', 10 * MIN, () => orderService.autoComplete()],
  ['flag-missing-checkouts', 15 * MIN, () => attendanceService.markMissingCheckouts()],
  ['mark-absences', 15 * MIN, () => attendanceService.markAbsences()],
  ['mark-overdue-invoices', 60 * MIN, () => invoiceService.markOverdue()],
  ['schedule-preventive-maintenance', 6 * 60 * MIN, () => maintenanceService.schedulePreventive()],
  ['notify-maintenance-due', 6 * 60 * MIN, () => maintenanceService.notifyDue()],
];

export const startJobs = () => {
  if (!env.jobsEnabled) return () => {};
  const timers = JOBS.map(([name, every, fn]) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { const n = await fn(); if (n) logger.info(`job ${name}: ${n} affected`); }
      catch (err) { logger.error(`job ${name} failed: ${err.message}`); }
      finally { running = false; }
    };
    setTimeout(tick, 5_000).unref(); // first run shortly after start-up
    return setInterval(tick, every).unref();
  });
  logger.info(`Background jobs started (${JOBS.length})`);
  return () => timers.forEach(clearInterval);
};
