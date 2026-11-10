import { randomUUID } from 'node:crypto';
import { env } from '../../config/environment.js';
import { AUDIT_ACTIONS, OTP_PURPOSES, ROLES, USER_STATUS } from '../../constants/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { comparePassword, generateOpaqueToken, getDummyPasswordHash, hashPassword, sha256 } from '../../utils/crypto.js';
import { signAccessToken } from '../../utils/token.js';
import { auditService } from '../audit-logs/audit.service.js';
import { userRepository } from '../users/user.repository.js';
import { authRepository } from './auth.repository.js';
import { otpService } from './otp.service.js';

const invalidCredentials = () => ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
const invalidRefresh = () => ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

const audit = (action, { actor, resourceId, before, after, ctx }) =>
  auditService.record({ actorId: actor?._id ?? null, action, resourceType: 'User', resourceId: resourceId ?? actor?._id ?? null, before, after, ctx });

/** Creates a refresh-token row and the matching access token. `familyId` is reused when rotating. */
const startSession = async (user, ctx, familyId = randomUUID()) => {
  const refreshToken = generateOpaqueToken();
  const tokenDoc = await authRepository.createRefreshToken({
    userId: user._id,
    tokenHash: sha256(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + env.refreshTokenTtlMs),
    deviceInfo: { userAgent: ctx.userAgent, ip: ctx.ip },
  });
  return {
    accessToken: signAccessToken(user),
    accessTokenExpiresAt: new Date(Date.now() + env.accessTokenTtlMs),
    refreshToken,
    tokenDoc,
  };
};

const assertPasswordChangeAllowed = (user) => {
  if (user.status !== USER_STATUS.ACTIVE) throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
};

export const authService = {
  // ------------------------------------------------------------------ registration
  async register({ fullName, email, phone, password }, ctx) {
    if (await userRepository.findDuplicate({ email, phone })) {
      throw ApiError.conflict('An account with this email or phone number already exists', 'ACCOUNT_EXISTS');
    }
    const user = await userRepository.create({
      fullName,
      email,
      phone,
      password: await hashPassword(password),
      role: ROLES.CUSTOMER, // public registration can only ever create customers
      status: USER_STATUS.ACTIVE,
      isVerified: false,
    });
    await otpService.issue({ user, purpose: OTP_PURPOSES.REGISTRATION });
    await audit(AUDIT_ACTIONS.AUTH_REGISTER, { actor: user, ctx });
    return user;
  },

  async verifyRegistration({ identifier, otp }, ctx) {
    const user = await userRepository.findByIdentifier(identifier);
    // Unknown and already-verified accounts get the same answer as a wrong code.
    if (!user || user.isVerified) throw ApiError.badRequest('Invalid or expired code', 'OTP_INVALID');
    await otpService.verify({ user, purpose: OTP_PURPOSES.REGISTRATION, otp });
    const verified = await userRepository.updateById(user._id, { $set: { isVerified: true } });
    await audit(AUDIT_ACTIONS.AUTH_ACCOUNT_VERIFIED, { actor: user, ctx });
    return verified;
  },

  /** Always resolves; the caller sends the same response whether or not anything was sent. */
  async resendRegistrationOtp({ identifier }) {
    const user = await userRepository.findByIdentifier(identifier);
    if (!user || user.isVerified || user.status !== USER_STATUS.ACTIVE) return;
    await otpService.issue({ user, purpose: OTP_PURPOSES.REGISTRATION }).catch((err) => {
      if (!(err instanceof ApiError)) throw err; // cooldown / hourly cap are swallowed on purpose
    });
  },

  // ------------------------------------------------------------------ sessions
  async login({ identifier, password }, ctx) {
    const user = await userRepository.findByIdentifierWithPassword(identifier);
    const passwordOk = await comparePassword(password, user?.password ?? (await getDummyPasswordHash()));
    if (!user || !passwordOk) {
      await audit(AUDIT_ACTIONS.AUTH_LOGIN_FAILED, { actor: user, resourceId: user?._id, ctx });
      throw invalidCredentials();
    }
    if (user.status !== USER_STATUS.ACTIVE) throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    if (!user.isVerified) {
      await otpService.issue({ user, purpose: OTP_PURPOSES.REGISTRATION }).catch(() => {});
      throw ApiError.forbidden('Account is not verified. A new verification code has been sent.', 'ACCOUNT_NOT_VERIFIED');
    }

    const session = await startSession(user, ctx);
    await userRepository.updateById(user._id, { $set: { lastLoginAt: new Date() } });
    await audit(AUDIT_ACTIONS.AUTH_LOGIN, { actor: user, ctx });
    return { user, session };
  },

  /** Refresh-token rotation with reuse detection. */
  async refresh(rawToken, ctx) {
    if (!rawToken) throw ApiError.unauthorized('Refresh token missing', 'REFRESH_TOKEN_MISSING');
    const hash = sha256(rawToken);

    const current = await authRepository.revokeRefreshTokenIfActive(hash);
    if (!current) {
      const known = await authRepository.findRefreshTokenByHash(hash);
      if (known?.revokedAt && known.replacedByTokenId) {
        // A token that was already ROTATED is being replayed: assume it was stolen and kill every
        // session descended from the same login. (A token that was merely logged out, or revoked as
        // part of an earlier family kill, is just refused: that is not evidence of theft.)
        await authRepository.revokeFamily(known.familyId);
        await auditService.record({
          actorId: known.userId, action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
          resourceType: 'RefreshToken', resourceId: known._id, ctx,
        });
      }
      throw invalidRefresh();
    }

    const user = await userRepository.findById(current.userId);
    if (!user || user.status !== USER_STATUS.ACTIVE || !user.isVerified) {
      await authRepository.revokeFamily(current.familyId);
      throw invalidRefresh();
    }

    const session = await startSession(user, ctx, current.familyId);
    await authRepository.setReplacedBy(current._id, session.tokenDoc._id);
    return { user, session };
  },

  async logout(rawToken, ctx) {
    if (!rawToken) return;
    const revoked = await authRepository.revokeRefreshTokenIfActive(sha256(rawToken));
    if (revoked) {
      await auditService.record({ actorId: revoked.userId, action: AUDIT_ACTIONS.AUTH_LOGOUT, resourceType: 'User', resourceId: revoked.userId, ctx });
    }
  },

  /** Ends every session on every device, including access tokens already issued. */
  async logoutAll(actor, ctx) {
    await authRepository.revokeAllForUser(actor._id);
    await userRepository.updateById(actor._id, { $inc: { tokenVersion: 1 } });
    await audit(AUDIT_ACTIONS.AUTH_LOGOUT_ALL, { actor, ctx });
  },

  /** Ends every session of ANY user (used when an Admin/Manager deactivates or deletes an account). */
  async revokeAllSessions(userId) {
    await authRepository.revokeAllForUser(userId);
    await userRepository.updateById(userId, { $inc: { tokenVersion: 1 } });
  },

  // ------------------------------------------------------------------ password management
  /** Always resolves; the response never reveals whether the account exists. */
  async forgotPassword({ identifier }) {
    const user = await userRepository.findByIdentifier(identifier);
    if (!user || !user.isVerified || user.status !== USER_STATUS.ACTIVE) return;
    await otpService.issue({ user, purpose: OTP_PURPOSES.PASSWORD_RESET }).catch((err) => {
      if (!(err instanceof ApiError)) throw err;
    });
  },

  /** Verifies and consumes the reset code in one step, so a reset code is single-use by construction. */
  async resetPassword({ identifier, otp, newPassword }, ctx) {
    const user = await userRepository.findByIdentifier(identifier);
    if (!user || !user.isVerified || user.status !== USER_STATUS.ACTIVE) {
      throw ApiError.badRequest('Invalid or expired code', 'OTP_INVALID');
    }
    await otpService.verify({ user, purpose: OTP_PURPOSES.PASSWORD_RESET, otp });
    await userRepository.updateById(user._id, {
      $set: { password: await hashPassword(newPassword), passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    });
    await authRepository.revokeAllForUser(user._id);
    await audit(AUDIT_ACTIONS.AUTH_PASSWORD_RESET, { actor: user, ctx });
  },

  async changePassword(actor, { currentPassword, newPassword }, ctx) {
    const user = await userRepository.findByIdWithPassword(actor._id);
    assertPasswordChangeAllowed(user);
    if (!(await comparePassword(currentPassword, user.password))) {
      throw ApiError.badRequest('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }
    if (await comparePassword(newPassword, user.password)) {
      throw ApiError.badRequest('New password must be different from the current one', 'PASSWORD_UNCHANGED');
    }
    await userRepository.updateById(user._id, {
      $set: { password: await hashPassword(newPassword), passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    });
    await authRepository.revokeAllForUser(user._id);
    await audit(AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, { actor: user, ctx });
  },

  // ------------------------------------------------------------------ account management
  async updateProfile(actor, { fullName, avatar }, ctx) {
    const changes = {};
    if (fullName !== undefined) changes.fullName = fullName;
    if (avatar !== undefined) changes.avatar = avatar;
    const before = { fullName: actor.fullName, avatar: actor.avatar };
    const updated = await userRepository.updateById(actor._id, { $set: changes });
    await audit(AUDIT_ACTIONS.USER_PROFILE_UPDATED, { actor, before, after: changes, ctx });
    return updated;
  },

  /** Self-service deactivation. Re-activation is an Admin/Manager action (Phase 4). */
  async deactivateOwnAccount(actor, { password }, ctx) {
    const user = await userRepository.findByIdWithPassword(actor._id);
    if (!(await comparePassword(password, user.password))) {
      throw ApiError.badRequest('Password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }
    await userRepository.updateById(user._id, { $set: { status: USER_STATUS.INACTIVE }, $inc: { tokenVersion: 1 } });
    await authRepository.revokeAllForUser(user._id);
    await audit(AUDIT_ACTIONS.USER_DEACTIVATED, { actor: user, before: { status: user.status }, after: { status: USER_STATUS.INACTIVE }, ctx });
  },
};
