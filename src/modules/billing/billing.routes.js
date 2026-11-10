import { Router } from 'express';
import Joi from 'joi';
import { CHARGE_CATEGORIES as C } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorizeAnyPermission, authorizePermissions } from '../../middlewares/authorize.js';
import { createRateLimiter } from '../../middlewares/rate-limiter.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { handle } from '../../utils/handler.js';
import { idParams, objectId, pagination } from '../../utils/joi-rules.js';
import { getRequestContext as ctx } from '../../utils/requestContext.js';
import { sendSuccess } from '../../utils/response.js';
import { invoiceService } from '../invoices/invoice.service.js';
import { paymentService } from '../payments/payment.service.js';
import { billingService } from './billing.service.js';

const caller = (req) => ({ user: req.user, permissions: req.permissions });
const money = Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER);
const idem = Joi.string().trim().min(8).max(80);
const readAny = authorizeAnyPermission(P.BILLING_READ_ALL, P.BILLING_READ_OWN);

// ---------------- /api/billing-accounts ----------------
export const billingRouter = Router();
billingRouter.use(authenticate);
billingRouter.get('/', readAny, validate({ query: Joi.object({ ...pagination, bookingId: objectId }) }), handle((req) => billingService.list(caller(req), req.query)));
billingRouter.get('/:id', readAny, validate({ params: idParams }), handle(async (req) => (await billingService.getForCaller(caller(req), req.params.id)).toJSON()));
billingRouter.get('/:id/charges', readAny, validate({ params: idParams, query: Joi.object({ ...pagination, status: Joi.string().valid('POSTED', 'VOIDED'), category: Joi.string().valid(...Object.values(C)) }) }), handle((req) => billingService.listCharges(caller(req), req.params.id, req.query)));
billingRouter.post('/:id/charges', authorizePermissions(P.BILLING_ADJUST), validate({ params: idParams, body: Joi.object({ category: Joi.string().valid(C.SURCHARGE, C.DISCOUNT, C.ADDITIONAL_SERVICE).required(), description: Joi.string().trim().max(200).required(), quantity: Joi.number().integer().min(1).max(1000).default(1), unitPriceMinor: money.required(), reason: Joi.string().trim().max(200) }) }), handle((req) => billingService.addManualCharge(caller(req), req.params.id, req.body, ctx(req)), { status: 201, message: 'Charge added' }));
billingRouter.post('/:id/invoices', authorizePermissions(P.INVOICE_MANAGE), validate({ params: idParams }), handle((req) => invoiceService.generate(caller(req), req.params.id, ctx(req)), { status: 201, message: 'Invoice draft generated' }));

// ---------------- /api/invoices ----------------
export const invoiceRouter = Router();
invoiceRouter.use(authenticate);
const invRead = authorizeAnyPermission(P.BILLING_READ_ALL, P.INVOICE_READ_OWN);
invoiceRouter.get('/', invRead, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'REFUNDED'), bookingId: objectId, customerId: objectId, invoiceNumber: Joi.string().max(30), from: Joi.date().iso(), to: Joi.date().iso(), sortBy: Joi.string().valid('issuedAt', 'createdAt', 'grandTotalMinor') }) }), handle((req) => invoiceService.list(caller(req), req.query)));
invoiceRouter.get('/:id', invRead, validate({ params: idParams }), handle((req) => invoiceService.get(caller(req), req.params.id)));
invoiceRouter.get('/:id/pdf', invRead, validate({ params: idParams }), asyncHandler(async (req, res) => {
  const { buffer, filename } = await invoiceService.pdf(caller(req), req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': buffer.length }).send(buffer);
}));
invoiceRouter.post('/:id/issue', authorizePermissions(P.INVOICE_MANAGE), validate({ params: idParams }), handle((req) => invoiceService.issue(caller(req), req.params.id, ctx(req)), { message: 'Invoice issued' }));
invoiceRouter.post('/:id/adjustments', authorizePermissions(P.BILLING_ADJUST), validate({ params: idParams, body: Joi.object({ adjustmentType: Joi.string().valid('CREDIT', 'DEBIT').required(), amountMinor: money.required(), reason: Joi.string().trim().min(3).max(500).required() }) }), handle((req) => invoiceService.adjust(caller(req), req.params.id, req.body, ctx(req)), { status: 201, message: 'Adjustment recorded' }));
invoiceRouter.post('/:id/void', authorizePermissions(P.INVOICE_MANAGE), validate({ params: idParams, body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }) }), handle(async (req) => {
  if (req.user.role !== 'ADMIN') { const { ApiError } = await import('../../utils/ApiError.js'); throw ApiError.forbidden('Only Admins can void invoices'); }
  await invoiceService.voidInvoice(caller(req), req.params.id, req.body.reason, ctx(req)); return null;
}, { message: 'Invoice voided' }));

// ---------------- /api/payments ----------------
export const paymentRouter = Router();
// The webhook has no user session: it is authenticated by its HMAC signature, so it sits before `authenticate`.
paymentRouter.post('/webhook', createRateLimiter({ limit: 300 }), asyncHandler(async (req, res) => {
  const result = await paymentService.handleWebhook(req.rawBody, req.get('x-signature'));
  return sendSuccess(res, { message: result.duplicate ? 'Duplicate event ignored' : 'Event processed', data: result });
}));
paymentRouter.use(authenticate);
const replay = (fn) => asyncHandler(async (req, res) => { const r = await fn(req); return sendSuccess(res, { statusCode: r.replayed ? 200 : 201, message: r.replayed ? 'Request already processed' : 'Created', data: r.payment ?? r.refund }); });
paymentRouter.post('/', authorizePermissions(P.PAYMENT_CREATE), validate({ body: Joi.object({ accountId: objectId, bookingId: objectId, amountMinor: money.required(), method: Joi.string().valid('CASH', 'CARD', 'BANK_TRANSFER').required(), idempotencyKey: idem.required(), transactionReference: Joi.string().trim().max(80), note: Joi.string().max(300) }).or('accountId', 'bookingId') }), replay((req) => paymentService.record(caller(req), req.body, ctx(req))));
paymentRouter.post('/online', authorizePermissions(P.PAYMENT_CREATE_OWN), validate({ body: Joi.object({ bookingId: objectId.required(), amountMinor: money.required(), idempotencyKey: idem.required() }) }), replay((req) => paymentService.initiateOnline(caller(req), req.body)));
paymentRouter.get('/', readAny, validate({ query: Joi.object({ ...pagination, status: Joi.string().valid('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'), method: Joi.string().valid('CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE'), bookingId: objectId, sortBy: Joi.string().valid('createdAt', 'paidAt', 'amountMinor') }) }), handle((req) => paymentService.list(caller(req), req.query)));
paymentRouter.get('/:id', readAny, validate({ params: idParams }), handle((req) => paymentService.get(caller(req), req.params.id)));
paymentRouter.post('/:id/refund', authorizePermissions(P.PAYMENT_REFUND), validate({ params: idParams, body: Joi.object({ amountMinor: money.required(), reason: Joi.string().trim().min(3).max(500).required(), idempotencyKey: idem }) }), replay((req) => paymentService.refund(caller(req), req.params.id, req.body, ctx(req))));
