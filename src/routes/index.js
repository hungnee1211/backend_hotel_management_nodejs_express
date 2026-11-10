import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import guestRoutes from '../modules/guests/guest.routes.js';
import { managerRouter, staffRouter } from '../modules/staff/staff.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import auditRoutes from '../modules/audit-logs/audit.routes.js';
import { billingRouter, invoiceRouter, paymentRouter } from '../modules/billing/billing.routes.js';
import bookingRoutes from '../modules/bookings/booking.routes.js';
import housekeepingRoutes from '../modules/housekeeping/housekeeping.routes.js';
import { attendanceRouter, shiftRouter } from '../modules/shifts/shift.routes.js';
import { serviceRequestRouter, serviceRouter } from '../modules/hotel-services/hotelService.routes.js';
import menuRoutes from '../modules/menu/menu.routes.js';
import orderRoutes from '../modules/orders/order.routes.js';
import { equipmentRouter, facilityRouter, maintenanceRouter } from '../modules/facilities/facility.routes.js';
import notificationRoutes from '../modules/notifications/notification.routes.js';
import { analyticsRouter, dashboardRouter } from '../modules/analytics/analytics.routes.js';
import roomRoutes from '../modules/rooms/room.routes.js';
import roomTypeRoutes from '../modules/room-types/roomType.routes.js';
import { settingsRouter, taxRuleRouter } from '../modules/settings/settings.routes.js';
import healthRoutes from './health.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/staff', staffRouter);
router.use('/managers', managerRouter);
router.use('/guests', guestRoutes);
router.use('/room-types', roomTypeRoutes);
router.use('/rooms', roomRoutes);
router.use('/settings', settingsRouter);
router.use('/tax-rules', taxRuleRouter);
router.use('/audit-logs', auditRoutes);
router.use('/bookings', bookingRoutes);
router.use('/billing-accounts', billingRouter);
router.use('/invoices', invoiceRouter);
router.use('/payments', paymentRouter);
router.use('/housekeeping', housekeepingRoutes);
router.use('/shifts', shiftRouter);
router.use('/analytics', analyticsRouter);
router.use('/dashboard', dashboardRouter);
router.use('/facilities', facilityRouter);
router.use('/equipment', equipmentRouter);
router.use('/maintenance', maintenanceRouter);
router.use('/notifications', notificationRoutes);
router.use('/menu', menuRoutes);
router.use('/orders', orderRoutes);
router.use('/services', serviceRouter);
router.use('/service-requests', serviceRequestRouter);
router.use('/attendance', attendanceRouter);
// Feature routers are mounted here as phases are implemented, e.g.:
// router.use('/rooms', roomRoutes);   // Phase 5

export default router;
