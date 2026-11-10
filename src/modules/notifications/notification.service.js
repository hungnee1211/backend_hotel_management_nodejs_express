import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';

/**
 * Mock email/SMS gateway. A real provider replaces the body of sendOtp later; callers do not change.
 * The code is printed only in development and is never logged in production or test.
 */
export const notificationService = {
  async sendOtp({ channel, destination, otp, purpose }) {
    if (env.isDev) {
      // eslint-disable-next-line no-console
      console.log(`\n[MOCK ${channel}] to=${destination} purpose=${purpose} OTP=${otp}\n`);
    } else {
      logger.info('OTP dispatched', { channel, purpose });
    }
  },
};
