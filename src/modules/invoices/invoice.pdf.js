import PDFDocument from 'pdfkit';
import { formatMoney } from '../../utils/money.js';

const LABEL = { ROOM: 'Room', FOOD_AND_BEVERAGE: 'Food & beverage', ADDITIONAL_SERVICE: 'Services', SURCHARGE: 'Surcharge', DISCOUNT: 'Discount' };

/** Renders an invoice as a PDF buffer. Pure presentation: every number comes from the stored invoice. */
export const buildInvoicePdf = (inv) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  const m = (v) => formatMoney(v, inv.currency);
  const row = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(label, 48, doc.y, { continued: true, width: 350 }).text(value, { align: 'right' });
  };

  doc.font('Helvetica-Bold').fontSize(20).text('INVOICE');
  doc.font('Helvetica').fontSize(10).fillColor('#555').text(inv.status === 'DRAFT' ? 'DRAFT (not issued)' : `No. ${inv.invoiceNumber}   |   Issued ${new Date(inv.issuedAt).toISOString().slice(0, 10)}`).fillColor('#000');
  doc.moveDown().text(`Billed to: ${inv.customerSnapshot?.fullName ?? ''}`);
  if (inv.customerSnapshot?.email) doc.text(inv.customerSnapshot.email);
  doc.moveDown();

  doc.font('Helvetica-Bold').text('Description', 48, doc.y, { continued: true, width: 300 }).text('Qty', { continued: true, width: 50, align: 'right' }).text('Amount', { align: 'right' });
  doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).stroke().moveDown(0.5);
  for (const l of inv.lineItems) {
    doc.font('Helvetica').fontSize(9).text(`${LABEL[l.category] ?? l.category}: ${l.description}`.slice(0, 70), 48, doc.y, { continued: true, width: 300 }).text(String(l.quantity), { continued: true, width: 50, align: 'right' }).text(m(l.amountMinor), { align: 'right' });
    if (doc.y > 740) doc.addPage();
  }
  doc.moveDown();
  row('Subtotal', m(inv.subtotalMinor));
  if (inv.discountTotalMinor) row('Discounts', `-${m(inv.discountTotalMinor)}`);
  if (inv.surchargeTotalMinor) row('Surcharges', m(inv.surchargeTotalMinor));
  if (inv.serviceChargeMinor) row('Service charge', m(inv.serviceChargeMinor));
  for (const t of inv.taxBreakdown) row(`${t.name} ${(t.rateBps / 100).toFixed(2)}% on ${m(t.baseMinor)}`, m(t.taxMinor));
  if (inv.adjustmentsTotalMinor) row('Adjustments', m(inv.adjustmentsTotalMinor));
  doc.moveDown(0.5);
  row('Total', m(inv.grandTotalMinor + (inv.adjustmentsTotalMinor ?? 0)), true);
  row('Paid', m(inv.paidMinor));
  row('Outstanding', m(inv.outstandingMinor), true);
  doc.end();
});
