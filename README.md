# Hotel Management System: Backend

Node.js 20+ · Express 4 · MongoDB (Mongoose 8) · ES Modules · Yarn · Joi · JWT + opaque refresh tokens · bcryptjs

A single-hotel backend covering authentication/RBAC, staff & guests, rooms with a per-night inventory ledger, bookings,
check-in/out, housekeeping, shifts & attendance, room-service ordering, additional services, facilities/equipment/maintenance,
consolidated billing, invoices, payments/refunds, analytics and role-based dashboards.

**Status:** all 14 phases implemented. 262 automated tests (97% statement / 86% branch coverage) run against a real MongoDB replica set.

## Quick start
```bash
yarn install
cp .env.example .env     # set JWT_ACCESS_SECRET, OTP_SECRET (openssl rand -hex 48), PII_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d     # single-node MongoDB replica set (transactions REQUIRE a replica set)
yarn seed                # demo data; prints the generated login password once
yarn dev                 # http://localhost:5000/api/docs  (Swagger UI)
yarn test                # unit tests always run; DB-backed suites skip themselves if no replica set is reachable
```
`yarn create-admin` creates just the first Admin (from `ADMIN_*` in `.env`); public registration can only ever create customers.

## Scripts
| Script | Purpose |
|---|---|
| `yarn dev` / `yarn start` | run with watch / run in production |
| `yarn test` | Jest + Supertest (in band) |
| `yarn seed` | idempotent demo data (refuses production unless `--force-production` + `SEED_PASSWORD`) |
| `yarn create-admin` | bootstrap the first Admin |
| `yarn db:sync-indexes` | build indexes (production disables auto-indexing; run on every deploy) |
| `yarn docs:generate` | writes `docs/openapi.json` and `docs/postman_collection.json` from the live route table |

## Architecture
Routes -> (controller) -> service -> repository -> model. Shared models live in `src/models/`; feature code in `src/modules/<name>/`.
A service may call other modules' *services* (never their repositories); billing is a leaf that knows only `sourceType/sourceId`;
analytics is read-only. Phases 3-4 have separate controller files; from Phase 5 the controller is the one-line `handle(req => service...)`
adapter inside each `*.routes.js` (same responsibility, less boilerplate).

```
src/
  config/        environment (Joi-validated), database (+ replica-set check)
  constants/     enums, permission matrix
  middlewares/   authenticate, authorize, csrf, validate, sanitize, rate-limiter, error-handler, request-logger
  models/        33 Mongoose models
  modules/       auth users staff guests room-types rooms availability bookings billing invoices payments housekeeping
                 shifts attendance menu orders hotel-services facilities equipment maintenance notifications
                 analytics dashboard settings audit-logs counters
  jobs/          background scheduler
  docs/          OpenAPI generator (Joi -> JSON Schema)
  utils/         money, dates, pii, crypto, token, cookies, pagination, transaction, ...
scripts/         seed, create-admin, sync-indexes, generate-docs
tests/           unit/ + integration/ (real MongoDB)
```

## API documentation
- **Swagger UI:** `/api/docs` (on outside production; set `ENABLE_DOCS=true` to force). Raw spec: `/api/docs/openapi.json`.
- **Postman:** import `docs/postman_collection.json`, then call `POST /api/auth/login` (Postman keeps the HTTP-only cookies; `X-Requested-With` is preset).
- Both are **generated from the real routes**: paths, required permissions, who holds them, and request schemas come straight from the code. A test fails if any protected route lacks an explicit authorization policy.
- Conventions: success `{success, message, data, meta?}`; error `{success:false, message, code, errors[], requestId}`; lists are paginated (`page, limit, sortBy, order, search`).

## Business rules (the ones worth knowing)
**Availability and double-booking.** Availability comes from a `RoomNight` ledger (one row per room per night) with a unique `(roomId, date)` index, not from `Room.status`.
A booking claims all its nights inside one MongoDB transaction; any overlap fails with `409 ROOM_UNAVAILABLE` and nothing is left half-created.
Check-out day is exclusive (back-to-back stays are fine). Holds (deposit-pending bookings) carry an expiry and expired holds never block anyone. Maintenance windows use the same ledger.

**Time.** Instants are UTC; stay nights, attendance days and report months are hotel-local `YYYY-MM-DD` keys (`Settings.timezone`).

**Money.** Integer minor units only (VND has none). Percentages use BigInt with half-up rounding.

**Billing.** One `BillingAccount` per booking. Every charge comes from one source (`sourceType, sourceId, sourceKey`, unique) and is posted idempotently.
Room nights post at booking; an order posts when **delivered**; a service when **completed**; the cancellation/no-show fee when it happens.
Invoice calculation order: subtotal (room + F&B + services) -> discounts reduce it *before* tax, spread proportionally -> service charge on the discounted subtotal ->
tax per (rule x category), each line rounded half-up (the service charge is taxed with surcharges) -> `grand = subtotal - discounts + surcharges + service charge + tax`.
Issued invoices are immutable; corrections are `InvoiceAdjustment` records (Manager approval up to `Settings.billing.managerApprovalLimitMinor`, Admin above).
A payment *request* is not a payment: only verified/recorded successful payments change balances. Webhooks are HMAC-verified, de-duplicated and forward-only.

**Cancellation / no-show.** Free until `freeCancellationHoursBeforeCheckIn` before check-in (default 48 h); later, `penaltyNights` nights (default 1) are billed. Managers may waive. Arrival day passed = `NO_SHOW` with the same fee.

**Check-out.** One transaction: issue the invoice, verify the balance (a Manager can authorise leaving with a balance), mark rooms for housekeeping, free unused nights.
A room returns to stock only after cleaning **and** inspection (configurable) with no open tasks or blocks.

**Reports.** Revenue is read only from the billing ledger (never from orders/services directly), so nothing is counted twice; each metric's date basis is returned in the response (`definitions`).
Occupancy = sold ledger nights / available nights; ADR = room revenue / room nights billed; RevPAR = room revenue / available nights.

## Roles and permissions
`constants/permissions.js` is the single source. ADMIN: everything. MANAGER: their team, their facilities, hotel operations and reports. STAFF: base permissions + their **department's** (+ optional individual grants/revokes, limited to non-financial permissions). CUSTOMER: only their own records.
Out-of-scope resources return 404 (no existence probing).

## Background jobs
Hold expiry (1 min), no-shows, auto-completing delivered orders, missing check-outs and absences, overdue invoices, preventive-maintenance scheduling and reminders. All idempotent: safe on several instances. `ENABLE_JOBS=false` disables them.

## Configuration
Every variable is documented in `.env.example` and validated at start-up (the app refuses to boot on bad config or a non-replica-set MongoDB). Notables: `PII_ENCRYPTION_KEY` (**back it up**: lost key = unreadable ID numbers), `PAYMENT_WEBHOOK_SECRET`, `COOKIE_SAME_SITE`/`CLIENT_URL` (cross-site frontends need `SameSite=None`; Secure is then forced), `TRUST_PROXY` (set behind a proxy so rate limits and audit logs see real IPs).

## Deployment
1. Provision MongoDB as a **replica set** (Atlas, or self-hosted with `--replSet`). Use a least-privilege user; give it insert/find-only on `auditlogs` if you can.
2. Set all env vars from `.env.example` via your secret manager (`NODE_ENV=production`, strong secrets, `CLIENT_URL`, `TRUST_PROXY`).
3. `yarn install --frozen-lockfile --production && yarn db:sync-indexes && yarn create-admin`, then `yarn start`. Or `docker build -t hotel-api .` (non-root, healthcheck on `/api/health`; readiness at `/api/health/ready`).
4. Put TLS in front. Frontend and API on different sites: set `COOKIE_SAME_SITE=none` and a precise `CLIENT_URL`; the frontend must send `X-Requested-With: XMLHttpRequest` and `credentials: 'include'`.
5. Shut-down is graceful on SIGTERM. See `docs/SECURITY_REVIEW.md` for the pre-production checklist.

## Assumptions and known limitations
- **VAT is a placeholder (10%, seeded `TaxRule`).** Confirm the real rate and change it via `POST /api/tax-rules` (rates are versioned; history is never rewritten).
- Cancellation policy and deposit are the agreed defaults (48 h / 1 night / 0%), editable in `PATCH /api/settings`.
- Single hotel (no multi-branch). Specific rooms are booked (not room types).
- Tax is computed per (rule x category), not per line item; the breakdown reconciles exactly to the total.
- A guest leaving early still pays the booked nights but the unused nights return to inventory; ADR therefore divides by *billed* nights.
- Payment provider is a mock with a real signed-webhook pipeline; plug a gateway adapter in `payments/`. OTP/notification delivery is a console mock; notifications are in-app only.
- Images are HTTPS URLs; there is no upload endpoint (Cloudinary/multer variables are reserved).
- Role changes (e.g. promoting Staff to Manager) and forced password change at first login are not implemented.
- Invoice adjustments/refunds use a single approver with a role-based limit, not two-person approval.
- Rate limiting is per instance; concurrency is tested with several parallel requests on one node, not load-tested.
