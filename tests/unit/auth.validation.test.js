import { authValidation as v } from '../../src/modules/auth/auth.validation.js';

const check = (schema, value) => schema.body.validate(value, { abortEarly: false, stripUnknown: true });

describe('register validation', () => {
  const base = { fullName: 'Nguyen Van A', email: 'A@Example.com', password: 'Passw0rdOK' };

  test('normalizes email and phone', () => {
    expect(check(v.register, base).value.email).toBe('a@example.com');
    const withPhone = check(v.register, { fullName: 'An', phone: '+84 90-123-4567', password: 'Passw0rdOK' });
    expect(withPhone.error).toBeUndefined();
    expect(withPhone.value.phone).toBe('+84901234567');
  });

  test('requires email or phone', () => {
    expect(check(v.register, { fullName: 'An', password: 'Passw0rdOK' }).error).toBeDefined();
  });

  test('strips role and verification flags (mass assignment)', () => {
    const { value } = check(v.register, { ...base, role: 'ADMIN', isVerified: true, status: 'ACTIVE' });
    expect(value).not.toHaveProperty('role');
    expect(value).not.toHaveProperty('isVerified');
    expect(value).not.toHaveProperty('status');
  });

  test('password rules: length, letter + digit, 72-byte bcrypt limit', () => {
    expect(check(v.register, { ...base, password: 'short1' }).error).toBeDefined();
    expect(check(v.register, { ...base, password: 'onlyletters' }).error).toBeDefined();
    expect(check(v.register, { ...base, password: '12345678' }).error).toBeDefined();
    expect(check(v.register, { ...base, password: `a1${'x'.repeat(71)}` }).error).toBeDefined();
    expect(check(v.register, { ...base, password: `${'é'.repeat(40)}1` }).error).toBeDefined(); // 81 bytes
  });

  test('rejects invalid emails and phones', () => {
    expect(check(v.register, { ...base, email: 'not-an-email' }).error).toBeDefined();
    expect(check(v.register, { fullName: 'An', phone: '12', password: 'Passw0rdOK' }).error).toBeDefined();
  });
});

describe('identifier / otp validation', () => {
  test('accepts email or phone identifiers and normalizes them', () => {
    expect(check(v.login, { identifier: ' Bob@Example.COM ', password: 'x' }).value.identifier).toBe('bob@example.com');
    expect(check(v.login, { identifier: '090 123 4567', password: 'x' }).value.identifier).toBe('0901234567');
    expect(check(v.login, { identifier: 'nope', password: 'x' }).error).toBeDefined();
  });

  test('otp must be exactly 6 digits', () => {
    expect(check(v.verifyOtp, { identifier: 'a@b.co', otp: '123456' }).error).toBeUndefined();
    for (const bad of ['12345', '1234567', 'abcdef', '12 456']) {
      expect(check(v.verifyOtp, { identifier: 'a@b.co', otp: bad }).error).toBeDefined();
    }
  });

  test('profile update only allows fullName and https avatar, and needs at least one field', () => {
    expect(check(v.updateProfile, {}).error).toBeDefined();
    expect(check(v.updateProfile, { avatar: 'http://insecure.example/a.png' }).error).toBeDefined();
    expect(check(v.updateProfile, { fullName: 'New Name', role: 'ADMIN' }).value).toEqual({ fullName: 'New Name' });
  });
});
