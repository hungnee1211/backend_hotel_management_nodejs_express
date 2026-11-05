import jwt from 'jsonwebtoken';
import { env } from '../../src/config/environment.js';
import { clearAuthCookies, setAuthCookies } from '../../src/utils/cookies.js';
import { comparePassword, generateOpaqueToken, generateOtp, hashOtp, hashPassword, safeEqual, sha256 } from '../../src/utils/crypto.js';
import { signAccessToken, verifyAccessToken } from '../../src/utils/token.js';

describe('crypto', () => {
  test('bcrypt hashes verify and are salted', async () => {
    const a = await hashPassword('Secret123');
    const b = await hashPassword('Secret123');
    expect(a).not.toBe(b);
    expect(await comparePassword('Secret123', a)).toBe(true);
    expect(await comparePassword('wrong', a)).toBe(false);
  });

  test('OTP hash is deterministic but bound to identifier and purpose', () => {
    const h = hashOtp('a@b.co', 'REGISTRATION', '123456');
    expect(hashOtp('a@b.co', 'REGISTRATION', '123456')).toBe(h);
    expect(hashOtp('x@b.co', 'REGISTRATION', '123456')).not.toBe(h);
    expect(hashOtp('a@b.co', 'PASSWORD_RESET', '123456')).not.toBe(h);
    expect(h).not.toContain('123456');
  });

  test('generated OTPs are 6 digits (including leading zeros)', () => {
    for (let i = 0; i < 200; i += 1) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  test('opaque tokens are long, unique, and hashed deterministically', () => {
    const t1 = generateOpaqueToken();
    expect(t1.length).toBeGreaterThanOrEqual(60);
    expect(t1).not.toBe(generateOpaqueToken());
    expect(sha256(t1)).toBe(sha256(t1));
    expect(sha256(t1)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('safeEqual handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('access tokens', () => {
  const user = { _id: '64b000000000000000000001', role: 'STAFF', tokenVersion: 3 };

  test('round-trips subject, role claim and version', () => {
    const payload = verifyAccessToken(signAccessToken(user));
    expect(payload).toMatchObject({ sub: user._id, role: 'STAFF', ver: 3, iss: 'hotel-management-api' });
    expect(payload.exp - payload.iat).toBe(Math.floor(env.accessTokenTtlMs / 1000));
  });

  test('rejects tampered, wrong-secret, alg=none and wrong-issuer tokens', () => {
    const good = signAccessToken(user);
    expect(() => verifyAccessToken(`${good.slice(0, -2)}xx`)).toThrow();
    expect(() => verifyAccessToken(jwt.sign({ ver: 3 }, 'another-secret-another-secret-123456', { subject: user._id, issuer: 'hotel-management-api' }))).toThrow();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user._id, iss: 'hotel-management-api', ver: 3 })).toString('base64url')}.`;
    expect(() => verifyAccessToken(none)).toThrow();
    expect(() => verifyAccessToken(jwt.sign({ ver: 3 }, env.JWT_ACCESS_SECRET, { subject: user._id, issuer: 'someone-else' }))).toThrow();
  });
});

describe('auth cookies', () => {
  const fakeRes = () => {
    const calls = [];
    return { calls, cookie: (...a) => calls.push(['set', ...a]), clearCookie: (...a) => calls.push(['clear', ...a]) };
  };

  test('both cookies are HttpOnly; refresh token is scoped to /api/auth', () => {
    const res = fakeRes();
    setAuthCookies(res, { accessToken: 'A', refreshToken: 'R' });
    const [access, refresh] = res.calls;
    expect(access[1]).toBe('access_token');
    expect(access[3]).toMatchObject({ httpOnly: true, path: '/', maxAge: env.accessTokenTtlMs });
    expect(refresh[1]).toBe('refresh_token');
    expect(refresh[3]).toMatchObject({ httpOnly: true, path: '/api/auth', maxAge: env.refreshTokenTtlMs });
  });

  test('clearing uses the same path/flags so browsers actually remove them', () => {
    const res = fakeRes();
    clearAuthCookies(res);
    expect(res.calls.map((c) => [c[1], c[2].path])).toEqual([['access_token', '/'], ['refresh_token', '/api/auth']]);
  });
});
