import { blindIndex, decryptPii, encryptPii, lastFour } from '../../src/utils/pii.js';

describe('PII encryption', () => {
  test('round-trips, including unicode', () => {
    for (const v of ['B1234567', 'C 079-090-123456', 'Số hộ chiếu 123']) expect(decryptPii(encryptPii(v))).toBe(v);
  });

  test('ciphertext hides the value and is different every time (random IV)', () => {
    const a = encryptPii('B1234567');
    const b = encryptPii('B1234567');
    expect(a).not.toBe(b);
    expect(a).not.toContain('B1234567');
    expect(a.startsWith('v1.')).toBe(true);
  });

  test('tampering and malformed values are detected (GCM authentication)', () => {
    const [v, iv, tag, ct] = encryptPii('B1234567').split('.');
    const flipped = `${ct.slice(0, -2)}${ct.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => decryptPii([v, iv, tag, flipped].join('.'))).toThrow();
    expect(() => decryptPii('garbage')).toThrow();
    expect(() => decryptPii(['v2', iv, tag, ct].join('.'))).toThrow();
  });

  test('blind index is deterministic and ignores case, spaces and dashes', () => {
    expect(blindIndex('b-123 4567')).toBe(blindIndex('B1234567'));
    expect(blindIndex('B1234567')).not.toBe(blindIndex('B1234568'));
    expect(blindIndex('B1234567')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('last four characters', () => {
    expect(lastFour('B1234567')).toBe('4567');
    expect(lastFour('079-090-123456')).toBe('3456');
  });
});
