export const PHONE_REGEX = /^\+?[0-9]{8,15}$/;

export const normalizeEmail = (email) => String(email).trim().toLowerCase();
/** Strips spaces, dashes, dots and parentheses: "+84 90-123-4567" -> "+84901234567". */
export const normalizePhone = (phone) => String(phone).replace(/[\s\-().]/g, '');

/** An identifier containing "@" is an email, anything else is a phone number. */
export const identifierQuery = (identifier) => {
  const raw = String(identifier).trim();
  return raw.includes('@') ? { email: normalizeEmail(raw) } : { phone: normalizePhone(raw) };
};
