import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { createRateLimiter } from '../../middlewares/rate-limiter.js';
import { validate } from '../../middlewares/validate.js';
import * as controller from './auth.controller.js';
import { authValidation as v } from './auth.validation.js';

const router = Router();

// Throttle per client IP + target account, so one attacker can't lock a victim out of their own account.
const perAccount = (req) => `${req.ip}|${String(req.body?.identifier ?? '').toLowerCase()}`;
const registerLimiter = createRateLimiter({ limit: 10, message: 'Too many sign-up attempts, try again later' });
const loginLimiter = createRateLimiter({ limit: 10, keyGenerator: perAccount, message: 'Too many login attempts, try again later' });
const otpLimiter = createRateLimiter({ limit: 10, keyGenerator: perAccount, message: 'Too many code requests, try again later' });
const refreshLimiter = createRateLimiter({ limit: 60 });

// ---- public ----
router.post('/register', registerLimiter, validate(v.register), controller.register);
router.post('/verify-otp', otpLimiter, validate(v.verifyOtp), controller.verifyOtp);
router.post('/resend-otp', otpLimiter, validate(v.resendOtp), controller.resendOtp);
router.post('/login', loginLimiter, validate(v.login), controller.login);
router.post('/refresh', refreshLimiter, controller.refresh);
router.post('/logout', controller.logout);
router.post('/forgot-password', otpLimiter, validate(v.forgotPassword), controller.forgotPassword);
router.post('/reset-password', otpLimiter, validate(v.resetPassword), controller.resetPassword);

// ---- authenticated (any role) ----
router.get('/me', authenticate, controller.me);
router.patch('/me', authenticate, validate(v.updateProfile), controller.updateMe);
router.post('/change-password', authenticate, validate(v.changePassword), controller.changePassword);
router.post('/logout-all', authenticate, controller.logoutAll);
router.post('/deactivate', authenticate, validate(v.deactivate), controller.deactivateMe);

export default router;
