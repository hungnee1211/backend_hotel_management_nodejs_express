import Joi from 'joi';
import { email, identifier, password, phone } from '../../utils/joi-rules.js';

const otp = Joi.string().trim().pattern(/^\d{6}$/).messages({ 'string.pattern.base': 'must be a 6-digit code' });

export const authValidation = {
  register: {
    body: Joi.object({
      fullName: Joi.string().trim().min(2).max(120).required(),
      email,
      phone,
      password: password.required(),
    }).or('email', 'phone'),
  },
  verifyOtp: { body: Joi.object({ identifier: identifier.required(), otp: otp.required() }) },
  resendOtp: { body: Joi.object({ identifier: identifier.required() }) },
  login: { body: Joi.object({ identifier: identifier.required(), password: Joi.string().max(128).required() }) },
  forgotPassword: { body: Joi.object({ identifier: identifier.required() }) },
  resetPassword: {
    body: Joi.object({ identifier: identifier.required(), otp: otp.required(), newPassword: password.required() }),
  },
  changePassword: {
    body: Joi.object({ currentPassword: Joi.string().max(128).required(), newPassword: password.required() }),
  },
  updateProfile: {
    body: Joi.object({
      fullName: Joi.string().trim().min(2).max(120),
      avatar: Joi.string().uri({ scheme: ['https'] }).max(2048).allow(null),
    }).min(1),
  },
  deactivate: { body: Joi.object({ password: Joi.string().max(128).required() }) },
};
