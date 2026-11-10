# Security review

Scope: the backend as built through Phase 14. Every control below is exercised by an automated test unless marked **(manual)**.

## Authentication
| Control | Where | Tested |
|---|---|---|
| bcrypt (bcryptjs) password hashing, 72-byte limit enforced, timing-equalised login for unknown users | `utils/crypto.js`, `auth.service.js` | yes |
| 15-min JWT (HS256, issuer + algorithm pinned; `alg:none`, wrong secret, wrong issuer, expiry all rejected) | `utils/token.js` | yes |
| Opaque refresh tokens, stored as SHA-256, rotated on every use, reuse of a rotated token revokes the whole family, concurrent refresh = exactly one winner | `auth.service.js` | yes |
| HTTP-only cookies; refresh cookie scoped to `/api/auth`; Secure in production; SameSite configurable | `utils/cookies.js` | yes |
| CSRF: cookie-authenticated writes need `X-Requested-With` | `middlewares/csrf.js` | yes |
| OTP: HMAC-hashed, 5 min, 5 atomic attempts, single use, resend cooldown + hourly cap, purpose-bound | `otp.service.js` | yes |
| No account enumeration on login / resend / forgot-password | `auth.service.js` | yes |
| Password change / reset / logout-all / deactivation revoke refresh tokens AND live access tokens (`tokenVersion`) | `auth.service.js`, `authenticate.js` | yes |

## Authorization
| Control | Tested |
|---|---|
| Central role -> permission matrix; Staff permissions = base + department + overrides, recomputed per request | yes |
| Overrides can only grant `STAFF_GRANTABLE` permissions; managers cannot delegate what they lack | yes |
| Role and status are read from the database on every request, never from the token | yes |
| **Every protected route declares a permission or role (or is on an explicit "any authenticated" allow-list)**, checked against the live route table | yes (`docs.test.js`) |
| Ownership/scope in services: customers see only their own bookings, invoices, payments, orders, guests; managers only their team / facilities; out-of-scope = 404 (no existence probing) | yes |
| Self-escalation blocked: users cannot change their own role, status or manager; Admins cannot modify other Admins | yes |
| Client-supplied `role`, `ownerId`, `customerId`, prices and payment status are ignored (Joi strips unknown keys; prices come from server-side snapshots) | yes |

## Data integrity
| Control | Tested |
|---|---|
| Double booking impossible: unique `(roomId, date)` ledger index + transactions; 6 concurrent requests -> 1 booking, no orphans | yes |
| One billing charge per source (unique index + upsert); one invoice per stay (partial unique index); one payment per idempotency key | yes (incl. concurrent) |
| Money is integer minor units; BigInt percentage maths; no float arithmetic | yes |
| Webhooks: HMAC over raw body, unique event id, forward-only state machine, amount check | yes |
| Issued invoices are immutable; corrections are adjustment records; financial records are never deleted | yes |
| Audit log is append-only at the application layer | yes |

## Input handling
`$`-operator, dotted and prototype-pollution keys are rejected globally; Joi validates body, query and params everywhere; list endpoints cap page size; search terms are regex-escaped; JSON body limit 1 MB; Helmet headers; CORS allow-list with credentials; rate limits (global, per-IP+account on login/OTP, webhook).

## Sensitive data
Guest identification numbers: AES-256-GCM at rest, masked by default, revealing needs `guest:view-identification` and is audited, never written to audit logs, searchable via HMAC blind index. Password hashes, OTP hashes, refresh-token hashes are `select:false` and redacted from audit snapshots.

## Residual risks and recommendations (**manual**)
1. **Audit-log immutability is application-level.** In production connect with a MongoDB user that has only `insert`/`find` on `auditlogs`.
2. **`PII_ENCRYPTION_KEY` is a single static key.** Store it in a secret manager and back it up; the `v1.` prefix on ciphertexts allows adding key rotation.
3. **Initial passwords for staff are chosen by the creating manager** and there is no forced change at first login. Recommended follow-up.
4. **Rate limiting is in-memory per instance.** Behind several instances use a shared store (e.g. Redis) or enforce limits at the gateway.
5. **Payment provider is a mock.** A real gateway adapter must use its own signature scheme and verify amounts/currency server-side (the existing webhook pipeline shows the pattern).
6. **No account lockout** beyond rate limiting (deliberately, to avoid lock-out denial of service). Consider alerting on `AUTH_LOGIN_FAILED` bursts.
7. **Terminate TLS in front of the app** and set `TRUST_PROXY` correctly so client IPs (rate limits, audit logs) are real.
8. **Dependency hygiene:** run `yarn audit` in CI and pin versions via the lockfile.
