# Hotel Management System – Backend

Node.js · Express · MongoDB (Mongoose) · ES Modules · Yarn

**Status: Phase 4 (user, staff & guest management) complete**, on top of Phase 3 (auth & RBAC) and Phase 2 (foundation). Later phases add features module by module.

## Requirements
- Node.js ≥ 20, Yarn 1.x
- MongoDB **replica set** (transactions are required by booking/billing). Docker is the easiest way.

## Quick start
```bash
yarn install
cp .env.example .env          # then set JWT_ACCESS_SECRET, OTP_SECRET (32+ chars) and PII_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d          # single-node replica set on :27017
yarn dev                      # http://localhost:5000/api/health
yarn create-admin             # one-time: creates the first Admin from ADMIN_* in .env
yarn test                     # unit tests always run; the auth flow suite needs the replica set (skips itself if absent)
```
Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Scripts
| Script | Purpose |
|---|---|
| `yarn dev` | Run with `node --watch` |
| `yarn start` | Run (production) |
| `yarn create-admin` | Bootstrap the first Admin (idempotent). Public registration can only create CUSTOMERs |
| `yarn test` | Jest + Supertest (runs in band) |
| `yarn db:sync-indexes` | Build/update indexes (run on deploy; production disables autoIndex) |

## Structure (current)
```
src/
├── config/        environment.js (Joi-validated env), database.js (connect + replica-set check)
├── constants/     enums (roles, statuses, audit actions) + permissions.js (role -> permission matrix)
├── middlewares/   authenticate, authorize, csrf, request-logger, rate-limiter, sanitize, validate, not-found, error-handler
├── models/        Counter, Settings, TaxRule, User, OTP, RefreshToken, AuditLog, StaffProfile, Guest  (ALL models live here)
├── modules/       feature modules: <name>.routes|controller|service|repository|validation
│   ├── auth/            routes, controller, service, otp.service, repository, validation
│   ├── users/           directory, deactivate/reactivate/delete, manager-scope policy
│   ├── staff/           staff profiles, departments, permission overrides, manager hand-over
│   ├── guests/          guest profiles with encrypted ID numbers
│   ├── audit-logs/      append-only audit trail
│   ├── notifications/   mock OTP delivery (console in dev)
│   ├── counters/        atomic sequences (invoice / booking numbers)
│   └── settings/        hotel-wide configuration
├── routes/        /api router + health routes
├── utils/         ApiError, asyncHandler, response, pagination, money, dates, duration, logger, transaction
├── app.js         Express app (no listen, so tests can import it)
└── server.js      DB connect, settings bootstrap, listen, graceful shutdown
```
Planned module folders (auth, users, rooms, bookings, …) appear as their phases are built.

## Conventions
- **Layers:** routes → controller (thin) → service (rules, transactions) → repository (Mongoose) → model.
  A service may call other modules' *services*, never their repositories.
- **Responses:** success `{ success, message, data, meta? }`; error `{ success:false, message, code, errors:[], requestId }`.
- **Money:** integer minor units only (`utils/money.js`). VND has no minor unit. Tax rates are basis points.
- **Time:** instants in UTC; business days ("nights", attendance days, report months) are `YYYY-MM-DD` keys in the hotel timezone (`utils/dates.js`).
- **Transactions:** `withTransaction(async (session) => …)`; pass `{ session }` to every repository call; no network calls inside.
- **Input safety:** `$`-operator/dotted/prototype keys are rejected globally; Joi `validate()` strips unknown fields.

## Configuration
See `.env.example` (every variable documented). The app refuses to start on invalid config, and refuses a
standalone MongoDB unless `ALLOW_STANDALONE_MONGO=true` (non-transactional dev only).
Differences from the spec's variable list: no `JWT_REFRESH_SECRET` (refresh tokens are opaque and stored hashed);
added `OTP_SECRET`, `BCRYPT_ROUNDS`, `TRUST_PROXY`, `ALLOW_STANDALONE_MONGO`, `HOTEL_TIMEZONE`, `HOTEL_CURRENCY`.

## Authentication API (`/api/auth`)
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /register` | – | Create a CUSTOMER (email and/or phone). Sends an OTP |
| `POST /verify-otp` | – | Verify the registration code, activating the account |
| `POST /resend-otp` | – | New code (cooldown 60s, max 5/hour). Same response whether or not the account exists |
| `POST /login` | – | `{identifier, password}` where identifier is an email or phone. Sets HTTP-only cookies |
| `POST /refresh` | refresh cookie | Rotates the refresh token. Replay of a rotated token revokes the whole session family |
| `POST /logout` | refresh cookie | Revokes the refresh token, clears cookies |
| `POST /forgot-password` | – | Sends a reset code (silent for unknown accounts) |
| `POST /reset-password` | – | `{identifier, otp, newPassword}`. Code is single-use; revokes all sessions |
| `GET /me`, `PATCH /me` | any role | Read / update own profile (fullName, https avatar) |
| `POST /change-password` | any role | Requires the current password; revokes all sessions |
| `POST /logout-all` | any role | Ends every device session immediately |
| `POST /deactivate` | any role | Self-deactivation (requires password). Re-activation: Admin/Manager in Phase 4 |

```bash
curl -s -X POST localhost:5000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"fullName":"Tran Thi B","phone":"0901234567","password":"Matkhau123"}'
# dev mode prints the OTP in the server console:  [MOCK SMS] to=0901234567 purpose=REGISTRATION OTP=407114
curl -s -X POST localhost:5000/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"identifier":"0901234567","otp":"407114"}'
curl -s -c jar -X POST localhost:5000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"0901234567","password":"Matkhau123"}'
curl -s -b jar localhost:5000/api/auth/me
curl -s -b jar -X POST localhost:5000/api/auth/logout-all -H 'X-Requested-With: XMLHttpRequest'   # header required (CSRF)
```

## Security model (Phase 3)
- **Tokens:** 15-minute JWT access token and an opaque, hashed, rotating refresh token (7 days), both in HTTP-only cookies; never in the response body. `Authorization: Bearer` is also accepted for API tools.
- **Immediate revocation:** the user is loaded from the DB on every request, so role changes, deactivation and `logout-all` apply at once; `tokenVersion` kills already-issued access tokens after a password change.
- **CSRF:** cookie-authenticated POST/PUT/PATCH/DELETE must send `X-Requested-With: XMLHttpRequest` (Bearer and cookie-less requests are exempt). Required because the frontend may be cross-origin.
- **OTP:** HMAC-hashed, 5-minute expiry, 5 attempts (counted atomically before comparing), single use, older codes superseded, purpose-bound.
- **No account enumeration:** login, resend and forgot-password answer identically for unknown accounts.
- **Authorization:** `authorizeRoles`, `authorizePermissions` (matrix in `constants/permissions.js`) and `authorizeResourceOwnership`. Every protected route must declare its policy explicitly.
- **Audit:** register, verify, login (success/failure), logout, password changes, token-reuse detection, profile and deactivation events.

## Management API (Phase 4)
Scope rules: **Admin** = everything (but admin accounts are protected from each other). **Manager** = only staff who report to them; anything outside that returns 404. **Staff / Customer** = no directory access.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/managers` | Admin | Create a manager (already verified) |
| `POST /api/managers/:id/transfer-staff` | Admin | Move all of a manager's staff to another manager `{toManagerId}` |
| `POST /api/staff` | Admin, Manager | Create staff (user + profile, atomic). Managers' staff always report to themselves |
| `GET /api/staff` | Admin, Manager | Search/filter/paginate (`search, department, status, managerId*, sortBy, order, page, limit`; *Admin only) |
| `GET /api/staff/:id`, `/:id/permissions` | Admin, Manager (scoped) | Profile; breakdown of base / department / granted / revoked / effective permissions |
| `PATCH /api/staff/:id` | Admin, Manager (scoped) | `fullName, department, jobTitle, hiredAt, permissionOverrides`; `managerId` is Admin-only |
| `GET /api/staff/me` | Staff | Own profile |
| `GET /api/users`, `GET /api/users/:id` | Admin (all), Manager (own staff) | User directory |
| `PATCH /api/users/:id` | Admin, Manager (scoped) | Name / avatar only (never role, email, phone, password) |
| `POST /api/users/:id/deactivate`, `/reactivate` | Admin, Manager (scoped) | Reactivation does not revive old sessions |
| `DELETE /api/users/:id` | Admin | Soft delete; email/phone stay reserved |
| `POST/GET/PATCH /api/guests`, `GET /:id` | Front desk (RECEPTION, Manager, Admin) -> all guests; Customer -> own guests | Guest profiles; `GET ?idNumber=` finds a returning guest |
| `GET /api/guests/:id?revealIdentification=true` | Needs `guest:view-identification` | Full ID number. Every reveal is audited |
| `DELETE /api/guests/:id` | Manager, Admin | Soft delete |

`GET /api/auth/me` now also returns `permissions` (the caller's effective permission list) for the frontend.

### Staff permissions
`effective = role base + department permissions + individual grants - individual revokes` (revoke wins), recomputed on every request.
- Departments: `RECEPTION, HOUSEKEEPING, RESTAURANT, KITCHEN, MAINTENANCE` (table in `constants/permissions.js`).
- Overrides may only grant permissions some department already has (`STAFF_GRANTABLE`); financial, pricing, reporting, user-management and audit permissions can never be granted to Staff.
- A Manager can only delegate permissions they hold themselves.

### Guest identification
ID numbers are AES-256-GCM encrypted (`PII_ENCRYPTION_KEY`), never returned by default (`****1234`), searchable via an HMAC blind index, and never written to audit logs.
**Back up `PII_ENCRYPTION_KEY`: without it stored ID numbers cannot be recovered.** The `v1.` prefix on stored values allows key rotation later.
