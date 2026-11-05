import { env } from '../src/config/environment.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { ROLES, USER_STATUS } from '../src/constants/index.js';
import { userRepository } from '../src/modules/users/user.repository.js';
import { hashPassword } from '../src/utils/crypto.js';
import { logger } from '../src/utils/logger.js';
import { normalizeEmail, normalizePhone } from '../src/utils/identifier.js';

/**
 * Bootstraps the first Admin (public registration can never create one).
 * Reads ADMIN_NAME / ADMIN_EMAIL / ADMIN_PHONE / ADMIN_PASSWORD from the environment. Safe to re-run.
 */
try {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = env;
  if ((!ADMIN_EMAIL && !ADMIN_PHONE) || !ADMIN_PASSWORD) {
    throw new Error('Set ADMIN_PASSWORD and ADMIN_EMAIL (or ADMIN_PHONE) in your environment first.');
  }
  if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');

  await connectDatabase();
  const email = ADMIN_EMAIL ? normalizeEmail(ADMIN_EMAIL) : undefined;
  const phone = ADMIN_PHONE ? normalizePhone(ADMIN_PHONE) : undefined;

  if (await userRepository.findDuplicate({ email, phone })) {
    logger.info('An account with this email/phone already exists. Nothing to do.');
  } else {
    await userRepository.create({
      fullName: ADMIN_NAME || 'System Admin',
      email,
      phone,
      password: await hashPassword(ADMIN_PASSWORD),
      role: ROLES.ADMIN,
      status: USER_STATUS.ACTIVE,
      isVerified: true,
    });
    logger.info(`Admin account created for ${email ?? phone}`);
  }
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
