/** Converts Joi's own description of a schema into JSON Schema, so API docs can never drift from the real validation. */
const rule = (d, name) => d.rules?.find((r) => r.name === name)?.args;
/** Rules without arguments (integer, email, uri, hex) have no `args`, so test for the rule itself. */
const has = (d, name) => Boolean(d.rules?.some((r) => r.name === name));

export const toJsonSchema = (d) => {
  if (!d) return {};
  const s = {};
  switch (d.type) {
    case 'string': s.type = 'string'; break;
    case 'number': s.type = has(d, 'integer') ? 'integer' : 'number'; break;
    case 'boolean': s.type = 'boolean'; break;
    case 'date': s.type = 'string'; s.format = 'date-time'; break;
    case 'array': s.type = 'array'; s.items = d.items?.[0] ? toJsonSchema(d.items[0]) : {}; break;
    case 'object': {
      s.type = 'object'; s.properties = {}; const required = [];
      for (const [k, v] of Object.entries(d.keys ?? {})) { s.properties[k] = toJsonSchema(v); if (v.flags?.presence === 'required') required.push(k); }
      if (required.length) s.required = required;
      break;
    }
    default: break;
  }
  const min = rule(d, 'min')?.limit; const max = rule(d, 'max')?.limit;
  if (min !== undefined) s[s.type === 'string' ? 'minLength' : s.type === 'array' ? 'minItems' : 'minimum'] = min;
  if (max !== undefined) s[s.type === 'string' ? 'maxLength' : s.type === 'array' ? 'maxItems' : 'maximum'] = max;
  const len = rule(d, 'length')?.limit; if (len !== undefined) { s.minLength = len; s.maxLength = len; }
  const pat = rule(d, 'pattern')?.regex; if (pat) s.pattern = String(pat).replace(/^\/|\/[a-z]*$/g, '');
  if (has(d, 'email')) s.format = 'email';
  if (has(d, 'uri')) s.format = 'uri';
  if (has(d, 'hex')) s['x-hex'] = true;
  if (d.flags?.only && d.allow) s.enum = d.allow.filter((v) => v !== null && v !== '');
  if (d.allow?.includes(null)) s.nullable = true;
  if (d.flags?.default !== undefined && typeof d.flags.default !== 'object') s.default = d.flags.default;
  return s;
};

/** A plausible example value (required fields only), used for Postman bodies. */
export const example = (s, name = '') => {
  if (!s) return null;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case 'string':
      if (s.format === 'email') return 'user@example.com';
      if (s.format === 'uri') return 'https://example.com/image.png';
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.pattern?.includes('\\d{4}-')) return /out|^to$/i.test(name) ? '2026-12-03' : '2026-12-01';
      if (s.pattern?.includes('\\d{6}')) return '123456';
      if (s.pattern?.includes('\\d{2}:')) return '08:00';
      if (s['x-hex'] || s.minLength === 24) return '64b000000000000000000001';
      if (/password/i.test(name)) return 'Passw0rdOK';
      if (/identifier/i.test(name)) return 'user@example.com';
      if (/phone/i.test(name)) return '+84901234567';
      if (/key/i.test(name)) return 'unique-key-0001';
      return s.minLength > 6 ? 'x'.repeat(s.minLength) : 'string';
    case 'integer': case 'number': return s.minimum ?? 1;
    case 'boolean': return true;
    case 'array': return [example(s.items, name)];
    case 'object': return Object.fromEntries((s.required ?? []).map((k) => [k, example(s.properties[k], k)]));
    default: return null;
  }
};
