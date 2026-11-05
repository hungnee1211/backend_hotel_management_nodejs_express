import { jest } from '@jest/globals';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import { env } from '../../src/config/environment.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { AUDIT_ACTIONS, ROLES, USER_STATUS } from '../../src/constants/index.js';
import { PERMISSIONS } from '../../src/constants/permissions.js';
import { authenticate } from '../../src/middlewares/authenticate.js';
import { authorizePermissions, authorizeResourceOwnership, authorizeRoles } from '../../src/middlewares/authorize.js';
import { errorHandler } from '../../src/middlewares/error-handler.js';
import * as models from '../../src/models/index.js';
import { auditService } from '../../src/modules/audit-logs/audit.service.js';
import { notificationService } from '../../src/modules/notifications/notification.service.js';
import { hashPassword } from '../../src/utils/crypto.js';
import { signAccessToken } from '../../src/utils/token.js';
import { isDbAvailable } from '../helpers/db.js';

const { User, OTP, RefreshToken, AuditLog } = models;
const dbUp = await isDbAvailable();
const suite = dbUp ? describe : describe.skip;
if (!dbUp) console.warn('SKIPPING auth integration tests: no MongoDB replica set reachable (run `docker compose up -d`).'); // eslint-disable-line no-console

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const PASSWORD = 'Passw0rdOK';
let counter = 0;
const uniqueEmail = () => `user${Date.now()}${counter++}@example.com`;

const setCookies = (res) => res.headers['set-cookie'] ?? [];
const cookieValue = (res, name) => {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return line ? line.split(';')[0].slice(name.length + 1) : undefined;
};
const cookieHeader = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');

let sentOtps;
const lastOtp = () => sentOtps.at(-1).otp;

const register = (overrides = {}) =>
  request(app).post('/api/auth/register').send({ fullName: 'Test User', email: uniqueEmail(), password: PASSWORD, ...overrides });

/** Registers, verifies and logs in. Returns identifiers and the raw cookie values. */
const signUpAndLogin = async (overrides = {}) => {
  const email = overrides.email ?? uniqueEmail();
  await register({ ...overrides, email });
  await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: lastOtp() });
  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD });
  return { email, res, access: cookieValue(res, 'access_token'), refresh: cookieValue(res, 'refresh_token') };
};

const makeUser = async (role, extra = {}) =>
  User.create({
    fullName: `${role} user`, email: uniqueEmail(), password: await hashPassword(PASSWORD),
    role, status: USER_STATUS.ACTIVE, isVerified: true, ...extra,
  });

suite('auth flow (real MongoDB)', () => {
  beforeAll(async () => {
    await connectDatabase();
    await Promise.all(Object.values(models).map((m) => m.init())); // make sure unique indexes exist before tests
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });
  beforeEach(() => {
    sentOtps = [];
    jest.spyOn(notificationService, 'sendOtp').mockImplementation(async (msg) => { sentOtps.push(msg); });
  });
  afterEach(() => jest.restoreAllMocks());

  // ------------------------------------------------------------------ registration
  describe('registration', () => {
    test('creates an unverified CUSTOMER and never returns secrets, even if role/isVerified are sent', async () => {
      const res = await register({ role: 'ADMIN', isVerified: true, status: 'ACTIVE' });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ role: 'CUSTOMER', isVerified: false, status: 'ACTIVE' });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hashedCode|tokenVersion/i);
      expect(sentOtps).toHaveLength(1);
    });

    test('stores the OTP as an HMAC, never as plaintext', async () => {
      const email = uniqueEmail();
      await register({ email });
      const stored = await OTP.findOne({ identifier: email }).select('+hashedCode');
      expect(stored.hashedCode).not.toContain(lastOtp());
      expect(stored.hashedCode).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(env.otpTtlMs);
    });

    test('rejects duplicate email and duplicate phone (case/format-insensitive)', async () => {
      const email = uniqueEmail();
      expect((await register({ email })).status).toBe(201);
      expect((await register({ email: email.toUpperCase() })).status).toBe(409);
      expect((await register({ email: undefined, phone: '+84 91-111-0001' })).status).toBe(201);
      const dup = await register({ email: undefined, phone: '+84911110001' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ACCOUNT_EXISTS');
    });

    test('many users can register with phone only (partial unique index)', async () => {
      expect((await register({ email: undefined, phone: '+84922220001' })).status).toBe(201);
      expect((await register({ email: undefined, phone: '+84922220002' })).status).toBe(201);
    });

    test('validation errors return 422 with field details', async () => {
      const res = await register({ password: 'weak' });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('body.password');
    });
  });

  // ------------------------------------------------------------------ OTP
  describe('OTP verification', () => {
    test('unverified accounts cannot log in', async () => {
      const email = uniqueEmail();
      await register({ email });
      const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_NOT_VERIFIED');
    });

    test('correct code verifies once; the same code cannot be reused', async () => {
      const email = uniqueEmail();
      await register({ email });
      const otp = lastOtp();
      expect((await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp })).status).toBe(200);
      const again = await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp });
      expect(again.status).toBe(400);
      expect((await User.findOne({ email })).isVerified).toBe(true);
    });

    test('wrong codes are rejected and the attempt limit locks the code, even for the right value', async () => {
      const email = uniqueEmail();
      await register({ email });
      const right = lastOtp();
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 0; i < env.OTP_MAX_ATTEMPTS; i += 1) {
        expect((await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: wrong })).body.code).toBe('OTP_INVALID');
      }
      const locked = await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: right });
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect((await User.findOne({ email })).isVerified).toBe(false);
    });

    test('expired codes are rejected', async () => {
      const email = uniqueEmail();
      await register({ email });
      await OTP.updateMany({ identifier: email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: lastOtp() });
      expect(res.body.code).toBe('OTP_EXPIRED');
    });

    test('resend: cooldown blocks rapid requests silently; a new code supersedes the old one', async () => {
      const email = uniqueEmail();
      await register({ email });
      const first = lastOtp();
      const rapid = await request(app).post('/api/auth/resend-otp').send({ identifier: email });
      expect(rapid.status).toBe(200);
      expect(sentOtps).toHaveLength(1); // cooldown: nothing new sent

      // createdAt is immutable in Mongoose, so go through the native driver to age the code past the cooldown
      await OTP.collection.updateMany({ identifier: email }, { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
      await request(app).post('/api/auth/resend-otp').send({ identifier: email });
      expect(sentOtps).toHaveLength(2);
      const second = lastOtp();
      if (second !== first) {
        expect((await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: first })).status).toBe(400);
      }
      expect((await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: second })).status).toBe(200);
    });

    test('resend for unknown accounts looks identical and sends nothing', async () => {
      const res = await request(app).post('/api/auth/resend-otp').send({ identifier: 'ghost@example.com' });
      expect(res.status).toBe(200);
      expect(sentOtps).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ login & cookies
  describe('login and cookies', () => {
    test('sets HttpOnly cookies, keeps tokens out of the body, and /me works', async () => {
      const { res, access, refresh } = await signUpAndLogin();
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(access);
      expect(JSON.stringify(res.body)).not.toContain(refresh);
      const accessLine = setCookies(res).find((c) => c.startsWith('access_token='));
      const refreshLine = setCookies(res).find((c) => c.startsWith('refresh_token='));
      expect(accessLine).toMatch(/HttpOnly/i);
      expect(accessLine).toMatch(/SameSite=Lax/i);
      expect(refreshLine).toMatch(/HttpOnly/i);
      expect(refreshLine).toMatch(/Path=\/api\/auth/);

      const me = await request(app).get('/api/auth/me').set('Cookie', cookieHeader({ access_token: access }));
      expect(me.status).toBe(200);
      expect(me.body.data.user.role).toBe('CUSTOMER');
      expect(JSON.stringify(me.body)).not.toMatch(/password/i);
    });

    test('refresh tokens are stored hashed', async () => {
      const { refresh } = await signUpAndLogin();
      const rows = await RefreshToken.find({}).select('+tokenHash');
      expect(rows.some((r) => r.tokenHash === refresh)).toBe(false);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true);
    });

    test('login with a phone number works', async () => {
      const phone = '+84933330001';
      await register({ email: undefined, phone });
      await request(app).post('/api/auth/verify-otp').send({ identifier: phone, otp: lastOtp() });
      const res = await request(app).post('/api/auth/login').send({ identifier: '+84 933-330-001', password: PASSWORD });
      expect(res.status).toBe(200);
    });

    test('wrong password and unknown user give the same response (no account enumeration)', async () => {
      const { email } = await signUpAndLogin();
      const wrong = await request(app).post('/api/auth/login').send({ identifier: email, password: 'Wrong1234' });
      const unknown = await request(app).post('/api/auth/login').send({ identifier: 'nobody@example.com', password: 'Wrong1234' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body).toMatchObject({ message: wrong.body.message, code: wrong.body.code });
    });

    test('protected routes need a valid token; expired, tampered and alg=none tokens are refused', async () => {
      expect((await request(app).get('/api/auth/me')).status).toBe(401);
      const { access } = await signUpAndLogin();
      const userId = jwt.decode(access).sub;
      const expired = jwt.sign({ ver: 0 }, env.JWT_ACCESS_SECRET, { subject: userId, issuer: 'hotel-management-api', expiresIn: -10 });
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).body.code).toBe('TOKEN_EXPIRED');
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}x`)).body.code).toBe('INVALID_TOKEN');
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, iss: 'hotel-management-api', ver: 0 })).toString('base64url')}.`;
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${none}`)).status).toBe(401);
    });

    test('Bearer tokens work for API tools', async () => {
      const { access } = await signUpAndLogin();
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ CSRF
  describe('CSRF protection', () => {
    test('state-changing requests with cookies need X-Requested-With; safe methods do not', async () => {
      const { access } = await signUpAndLogin();
      const cookie = cookieHeader({ access_token: access });
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
      const blocked = await request(app).post('/api/auth/logout-all').set('Cookie', cookie);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('CSRF_REJECTED');
      expect((await request(app).post('/api/auth/logout-all').set('Cookie', cookie).set(XHR)).status).toBe(200);
    });

    test('Bearer clients are exempt', async () => {
      const { access } = await signUpAndLogin();
      expect((await request(app).post('/api/auth/logout-all').set('Authorization', `Bearer ${access}`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ refresh rotation
  describe('refresh token rotation', () => {
    test('rotates: new token issued, old token dies', async () => {
      const { access, refresh } = await signUpAndLogin();
      const res = await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }));
      expect(res.status).toBe(200);
      const newRefresh = cookieValue(res, 'refresh_token');
      expect(newRefresh).toBeTruthy();
      expect(newRefresh).not.toBe(refresh);
      expect(cookieValue(res, 'access_token')).toBeTruthy();
      expect(access).toBeTruthy();
      const rows = await RefreshToken.find({ userId: jwt.decode(access).sub });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    test('replaying a rotated token is detected, revokes the whole family and is audited', async () => {
      const { access, refresh: r1 } = await signUpAndLogin();
      const refreshWith = (token) => request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: token }));

      const r2 = cookieValue(await refreshWith(r1), 'refresh_token');
      const replay = await refreshWith(r1); // attacker (or buggy client) reuses the old token
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('INVALID_REFRESH_TOKEN');
      expect((await refreshWith(r2)).status).toBe(401); // the legitimate descendant is now dead too

      const userId = jwt.decode(access).sub;
      expect(await AuditLog.countDocuments({ actorId: userId, action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED })).toBe(1);
    });

    test('replaying a token that was only logged out is refused but does not raise a theft alarm', async () => {
      const { access, refresh } = await signUpAndLogin();
      await request(app).post('/api/auth/logout').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }));
      const res = await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }));
      expect(res.status).toBe(401);
      expect(await AuditLog.countDocuments({ actorId: jwt.decode(access).sub, action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED })).toBe(0);
    });

    test('concurrent refreshes with one token: exactly one succeeds', async () => {
      const { refresh } = await signUpAndLogin();
      const attempts = await Promise.all(
        Array.from({ length: 5 }, () => request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))),
      );
      expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
    });

    test('missing, garbage and expired refresh tokens are rejected', async () => {
      expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', 'refresh_token=garbage')).status).toBe(401);
      const { refresh } = await signUpAndLogin();
      await RefreshToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))).status).toBe(401);
    });

    test('multiple device sessions are independent', async () => {
      const { email, refresh: phone } = await signUpAndLogin();
      const laptop = cookieValue(await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD }), 'refresh_token');
      const refreshWith = (t) => request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: t }));
      expect((await refreshWith(phone)).status).toBe(200);
      expect((await refreshWith(laptop)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ logout
  describe('logout', () => {
    test('revokes the refresh token and clears cookies', async () => {
      const { refresh } = await signUpAndLogin();
      const res = await request(app).post('/api/auth/logout').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }));
      expect(res.status).toBe(200);
      expect(setCookies(res).some((c) => /^refresh_token=;/.test(c))).toBe(true);
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))).status).toBe(401);
    });

    test('logout without any cookie is harmless', async () => {
      expect((await request(app).post('/api/auth/logout')).status).toBe(200);
    });

    test('logout-all kills every session and already-issued access tokens', async () => {
      const { email, access, refresh } = await signUpAndLogin();
      const second = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD });
      await request(app).post('/api/auth/logout-all').set(XHR).set('Cookie', cookieHeader({ access_token: access }));
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}`)).body.code).toBe('TOKEN_REVOKED');
      for (const token of [refresh, cookieValue(second, 'refresh_token')]) {
        expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: token }))).status).toBe(401);
      }
    });
  });

  // ------------------------------------------------------------------ passwords
  describe('password management', () => {
    test('forgot-password is identical for unknown accounts and sends nothing', async () => {
      const res = await request(app).post('/api/auth/forgot-password').send({ identifier: 'ghost@example.com' });
      expect(res.status).toBe(200);
      expect(sentOtps).toHaveLength(0);
    });

    test('reset: single-use code, kills sessions and old access tokens, old password stops working', async () => {
      const { email, access, refresh } = await signUpAndLogin();
      sentOtps.length = 0;
      expect((await request(app).post('/api/auth/forgot-password').send({ identifier: email })).status).toBe(200);
      expect(sentOtps).toHaveLength(1);
      const otp = lastOtp();
      const wrong = otp === '000000' ? '111111' : '000000';

      expect((await request(app).post('/api/auth/reset-password').send({ identifier: email, otp: wrong, newPassword: 'NewPassw0rd1' })).status).toBe(400);
      const ok = await request(app).post('/api/auth/reset-password').send({ identifier: email, otp, newPassword: 'NewPassw0rd1' });
      expect(ok.status).toBe(200);
      expect((await request(app).post('/api/auth/reset-password').send({ identifier: email, otp, newPassword: 'Another0ne12' })).status).toBe(400); // single use

      expect((await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ identifier: email, password: 'NewPassw0rd1' })).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}`)).body.code).toBe('TOKEN_REVOKED');
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))).status).toBe(401);
    });

    test('a registration code cannot be used to reset a password (purpose binding)', async () => {
      const email = uniqueEmail();
      await register({ email });
      const registrationOtp = lastOtp();
      await request(app).post('/api/auth/verify-otp').send({ identifier: email, otp: registrationOtp });
      const res = await request(app).post('/api/auth/reset-password').send({ identifier: email, otp: registrationOtp, newPassword: 'NewPassw0rd1' });
      expect(res.status).toBe(400);
    });

    test('change-password requires the current password and revokes everything', async () => {
      const { email, access, refresh } = await signUpAndLogin();
      const bearer = { Authorization: `Bearer ${access}` };
      const bad = await request(app).post('/api/auth/change-password').set(bearer).send({ currentPassword: 'Wrong1234', newPassword: 'NewPassw0rd1' });
      expect(bad.body.code).toBe('INVALID_CURRENT_PASSWORD');
      const same = await request(app).post('/api/auth/change-password').set(bearer).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
      expect(same.body.code).toBe('PASSWORD_UNCHANGED');
      const ok = await request(app).post('/api/auth/change-password').set(bearer).send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd1' });
      expect(ok.status).toBe(200);
      expect((await request(app).get('/api/auth/me').set(bearer)).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ identifier: email, password: 'NewPassw0rd1' })).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ account management
  describe('account management', () => {
    test('profile update changes only allowed fields', async () => {
      const { access } = await signUpAndLogin();
      const res = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${access}`)
        .send({ fullName: 'Renamed User', role: 'ADMIN', email: 'hijack@example.com', avatar: 'https://cdn.example.com/a.png' });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ fullName: 'Renamed User', role: 'CUSTOMER', avatar: 'https://cdn.example.com/a.png' });
      expect(res.body.data.user.email).not.toBe('hijack@example.com');
    });

    test('self-deactivation needs the password, then blocks login, tokens and refresh', async () => {
      const { email, access, refresh } = await signUpAndLogin();
      const bearer = { Authorization: `Bearer ${access}` };
      expect((await request(app).post('/api/auth/deactivate').set(bearer).send({ password: 'Wrong1234' })).status).toBe(400);
      expect((await request(app).post('/api/auth/deactivate').set(bearer).send({ password: PASSWORD })).status).toBe(200);
      expect((await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.code).toBe('ACCOUNT_DISABLED');
      expect((await request(app).get('/api/auth/me').set(bearer)).status).toBe(403);
      expect((await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookieHeader({ refresh_token: refresh }))).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ RBAC middleware (real DB users)
  describe('authorization middleware', () => {
    const mini = express();
    mini.use(express.json());
    mini.use(cookieParser());
    mini.get('/admin-only', authenticate, authorizeRoles(ROLES.ADMIN), (req, res) => res.json({ ok: true }));
    mini.get('/revenue', authenticate, authorizePermissions(PERMISSIONS.REPORT_FINANCIAL), (req, res) => res.json({ ok: true }));
    mini.get('/owned/:ownerId', authenticate, authorizeResourceOwnership(async (req) => req.params.ownerId), (req, res) => res.json({ ok: true }));
    mini.use(errorHandler);

    const call = (path, user, token = signAccessToken(user)) => request(mini).get(path).set('Authorization', `Bearer ${token}`);

    test('role checks: Admin yes, everyone else 403, anonymous 401', async () => {
      const [admin, manager, staff, customer] = await Promise.all([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CUSTOMER].map((r) => makeUser(r)));
      expect((await request(mini).get('/admin-only')).status).toBe(401);
      expect((await call('/admin-only', admin)).status).toBe(200);
      for (const u of [manager, staff, customer]) expect((await call('/admin-only', u)).status).toBe(403);
    });

    test('permission checks: financial reports for Admin and Manager only', async () => {
      const [admin, manager, staff, customer] = await Promise.all([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF, ROLES.CUSTOMER].map((r) => makeUser(r)));
      expect((await call('/revenue', admin)).status).toBe(200);
      expect((await call('/revenue', manager)).status).toBe(200);
      expect((await call('/revenue', staff)).status).toBe(403);
      expect((await call('/revenue', customer)).status).toBe(403);
    });

    test('ownership: owner passes, other customers are refused, Admin bypasses', async () => {
      const [alice, bob, admin] = await Promise.all([ROLES.CUSTOMER, ROLES.CUSTOMER, ROLES.ADMIN].map((r) => makeUser(r)));
      expect((await call(`/owned/${alice._id}`, alice)).status).toBe(200);
      expect((await call(`/owned/${alice._id}`, bob)).status).toBe(403);
      expect((await call(`/owned/${alice._id}`, admin)).status).toBe(200);
    });

    test('the role comes from the database, not the token: a forged ADMIN claim is ignored', async () => {
      const customer = await makeUser(ROLES.CUSTOMER);
      const forged = jwt.sign({ role: 'ADMIN', ver: 0 }, env.JWT_ACCESS_SECRET, { subject: String(customer._id), issuer: 'hotel-management-api', expiresIn: 60 });
      expect((await call('/admin-only', customer, forged)).status).toBe(403);
    });

    test('role changes, deactivation and tokenVersion bumps take effect immediately', async () => {
      const user = await makeUser(ROLES.STAFF);
      const token = signAccessToken(user);
      expect((await call('/revenue', user, token)).status).toBe(403);
      await User.updateOne({ _id: user._id }, { $set: { role: ROLES.MANAGER } });
      expect((await call('/revenue', user, token)).status).toBe(200);
      await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
      expect((await call('/revenue', user, token)).body.code).toBe('TOKEN_REVOKED');
      await User.updateOne({ _id: user._id }, { $set: { status: USER_STATUS.INACTIVE } });
      expect((await call('/revenue', user, signAccessToken(await User.findById(user._id)))).body.code).toBe('ACCOUNT_DISABLED');
    });

    test('soft-deleted and unverified accounts are refused', async () => {
      const deleted = await makeUser(ROLES.STAFF, { deletedAt: new Date() });
      const unverified = await makeUser(ROLES.STAFF, { isVerified: false });
      expect((await call('/revenue', deleted)).status).toBe(401);
      expect((await call('/revenue', unverified)).body.code).toBe('ACCOUNT_NOT_VERIFIED');
    });
  });

  // ------------------------------------------------------------------ audit
  describe('audit log', () => {
    test('auth events are recorded with actor and request metadata, without secrets', async () => {
      const { email } = await signUpAndLogin();
      const user = await User.findOne({ email });
      const actions = (await AuditLog.find({ actorId: user._id })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining([AUDIT_ACTIONS.AUTH_REGISTER, AUDIT_ACTIONS.AUTH_ACCOUNT_VERIFIED, AUDIT_ACTIONS.AUTH_LOGIN]));
      const entry = await AuditLog.findOne({ actorId: user._id, action: AUDIT_ACTIONS.AUTH_LOGIN });
      expect(entry.ipAddress).toBeTruthy();
    });

    test('failed logins are audited', async () => {
      const { email } = await signUpAndLogin();
      await request(app).post('/api/auth/login').send({ identifier: email, password: 'Wrong1234' });
      const user = await User.findOne({ email });
      expect(await AuditLog.countDocuments({ actorId: user._id, action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED })).toBe(1);
    });

    test('sensitive fields are redacted from before/after snapshots', async () => {
      const user = await makeUser(ROLES.CUSTOMER);
      await auditService.record({ actorId: user._id, action: 'TEST', resourceType: 'User', resourceId: user._id, after: { password: 'x', hashedCode: 'y', nested: { token: 'z', ok: 1 } } });
      const entry = await AuditLog.findOne({ action: 'TEST' });
      expect(entry.after).toEqual({ nested: { ok: 1 } });
    });

    test('audit logs are append-only', async () => {
      const user = await makeUser(ROLES.CUSTOMER);
      await auditService.record({ actorId: user._id, action: 'IMMUTABLE_TEST', resourceType: 'User' });
      const entry = await AuditLog.findOne({ action: 'IMMUTABLE_TEST' });
      await expect(AuditLog.updateOne({ _id: entry._id }, { $set: { action: 'TAMPERED' } })).rejects.toThrow('append-only');
      await expect(AuditLog.deleteMany({})).rejects.toThrow('append-only');
      await expect(AuditLog.findOneAndUpdate({ _id: entry._id }, { $set: { action: 'X' } })).rejects.toThrow('append-only');
      entry.action = 'TAMPERED';
      await expect(entry.save()).rejects.toThrow('append-only');
      expect(await AuditLog.countDocuments({ action: 'IMMUTABLE_TEST' })).toBe(1);
    });
  });
});
