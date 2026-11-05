import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import guestRoutes from '../modules/guests/guest.routes.js';
import { managerRouter, staffRouter } from '../modules/staff/staff.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import healthRoutes from './health.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/staff', staffRouter);
router.use('/managers', managerRouter);
router.use('/guests', guestRoutes);
// Feature routers are mounted here as phases are implemented, e.g.:
// router.use('/rooms', roomRoutes);   // Phase 5

export default router;
