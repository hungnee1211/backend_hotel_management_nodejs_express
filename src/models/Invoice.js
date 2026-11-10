import { jsonTransform } from './_json.js';
import mongoose from 'mongoose';
import { INVOICE_STATUS } from '../constants/index.js';
const { Schema } = mongoose;
const schema = new Schema({
  invoiceNumber: { type: String }, // assigned when ISSUED
  billingAccountId: { type: Schema.Types.ObjectId, ref: 'BillingAccount', required: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  customerSnapshot: { fullName: String, email: String, phone: String },
  currency: String,
  lineItems: [{ _id: false, chargeId: Schema.Types.ObjectId, category: String, description: String, quantity: Number, unitPriceMinor: Number, amountMinor: Number }],
  taxBreakdown: [{ _id: false, code: String, name: String, rateBps: Number, category: String, baseMinor: Number, taxMinor: Number }],
  subtotalMinor: Number, discountTotalMinor: Number, surchargeTotalMinor: Number, serviceChargeMinor: Number, taxTotalMinor: Number,
  grandTotalMinor: Number,
  adjustmentsTotalMinor: { type: Number, default: 0 }, // signed sum of approved InvoiceAdjustments (credit negative)
  paidMinor: { type: Number, default: 0 }, outstandingMinor: Number,
  status: { type: String, enum: Object.values(INVOICE_STATUS), default: INVOICE_STATUS.DRAFT },
  isActive: { type: Boolean, default: true }, // false once VOID
  issuedAt: Date, dueAt: Date, voidedAt: Date, issuedBy: Schema.Types.ObjectId, createdBy: Schema.Types.ObjectId,
}, { timestamps: true });
schema.index({ invoiceNumber: 1 }, { unique: true, partialFilterExpression: { invoiceNumber: { $type: 'string' } } });
// At most one live invoice per stay.
schema.index({ billingAccountId: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
schema.index({ status: 1, dueAt: 1 });
schema.index({ issuedAt: 1 });
schema.index({ customerId: 1 });
schema.set('toJSON', { transform: jsonTransform });
export default mongoose.model('Invoice', schema);
