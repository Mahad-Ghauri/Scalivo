import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import type { AuditReport } from './report.js';

/**
 * The audit report as a printable A4 PDF: a cover summary, then the full
 * timeline as a table. Built on the server so the web and the app download the
 * exact same file.
 */

const INK = '#0d0d0d';
const MUTED = '#737373';
const LINE = '#e5e5e5';
const BRAND = '#6d4aff';
const TONE = { ok: '#1f9d55', warning: '#b7791f', problem: '#c53030' } as const;
const CATEGORY_LABEL: Record<string, string> = {
  booking: 'Booking',
  message: 'Message',
  payment: 'Payment',
  whatsapp: 'WhatsApp',
  review: 'Review',
  marketing: 'Marketing',
  services: 'Services',
  staff: 'Staff',
  customers: 'Customers',
  calendar: 'Calendar',
  settings: 'Settings',
};

const rupees = (minor: number) => `Rs ${Math.round(minor / 100).toLocaleString('en-PK')}`;

export function renderAuditPdf(report: AuditReport): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Audit report: ${report.business.name}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const tz = report.business.timezone;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const fmtDate = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toFormat('d LLL yyyy');

  // Header
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text('SCALIVO', left, 40);
  doc.fillColor(INK).fontSize(20).text('Audit report', left, 56);
  doc.fillColor(INK).font('Helvetica').fontSize(12).text(report.business.name, left, 82);
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text(
      `Period: ${fmtDate(report.range.from)} to ${fmtDate(report.range.to)}   ·   Generated ${DateTime.fromISO(report.generatedAt, { zone: tz }).toFormat('d LLL yyyy, h:mm a')} (${tz})`,
      left,
      100,
    );
  doc.moveTo(left, 118).lineTo(left + width, 118).strokeColor(LINE).stroke();

  // Summary tiles, 4 per row
  const s = report.summary;
  const tiles: [string, string][] = [
    ['Bookings', String(s.bookings)],
    ['Completed', String(s.completed)],
    ['Cancelled', String(s.cancelled)],
    ['No-shows', String(s.noShows)],
    ['Revenue (completed)', rupees(s.revenueMinor)],
    ['Messages sent', String(s.messagesSent)],
    ['Delivery rate', s.deliveryRate === null ? 'n/a' : `${s.deliveryRate}%`],
    ['Failed messages', String(s.messagesFailed)],
    ['WhatsApp disconnects', String(s.whatsappDisconnects)],
    ['Reviews', String(s.reviews)],
    ['Average rating', s.averageRating === null ? 'n/a' : `${s.averageRating} / 5`],
    ['Staff actions', String(s.staffActions)],
  ];
  const tileW = (width - 3 * 8) / 4;
  tiles.forEach(([label, value], i) => {
    const x = left + (i % 4) * (tileW + 8);
    const y = 132 + Math.floor(i / 4) * 52;
    doc.roundedRect(x, y, tileW, 44, 6).strokeColor(LINE).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x + 8, y + 8, { width: tileW - 16 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(value, x + 8, y + 21, { width: tileW - 16 });
  });
  let y = 132 + Math.ceil(tiles.length / 4) * 52 + 4;
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text(
      `Bookings by channel: WhatsApp ${s.bySource.whatsapp}, website ${s.bySource.web}, added by the business ${s.bySource.owner}.`,
      left,
      y,
    );
  y += 26;

  // Timeline table
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(`Activity (${report.events.length} entries)`, left, y);
  y += 22;
  const cols = [
    { label: 'Date & time', w: 92 },
    { label: 'Type', w: 62 },
    { label: 'What happened', w: width - 92 - 62 - 90 },
    { label: 'By', w: 90 },
  ];
  const header = () => {
    let x = left;
    doc.rect(left, y - 4, width, 18).fill('#f5f5f5');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.label, x + 4, y, { width: c.w - 8 });
      x += c.w;
    }
    y += 18;
  };
  header();

  if (!report.events.length)
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('Nothing happened in this period.', left, y + 6);

  for (const e of report.events) {
    const what = e.detail ? `${e.title}\n${e.detail}` : e.title;
    doc.font('Helvetica').fontSize(8.5);
    const h = Math.max(22, doc.heightOfString(what, { width: cols[2]!.w - 8 }), doc.heightOfString(e.actor || '-', { width: cols[3]!.w - 8 })) + 8;
    if (y + h > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    let x = left;
    doc.fillColor(INK).text(DateTime.fromISO(e.at, { zone: tz }).toFormat('d LLL yyyy\nh:mm a'), x + 4, y, { width: cols[0]!.w - 8 });
    x += cols[0]!.w;
    doc.circle(x + 7, y + 4, 2.5).fill(TONE[e.tone]);
    doc.fillColor(INK).text(CATEGORY_LABEL[e.category] ?? e.category, x + 13, y, { width: cols[1]!.w - 16 });
    x += cols[1]!.w;
    doc.font('Helvetica-Bold').fillColor(INK).text(e.title, x + 4, y, { width: cols[2]!.w - 8 });
    if (e.detail) doc.font('Helvetica').fillColor(MUTED).text(e.detail, { width: cols[2]!.w - 8 });
    x += cols[2]!.w;
    doc.font('Helvetica').fillColor(INK).text(e.actor || '-', x + 4, y, { width: cols[3]!.w - 8 });
    y += h;
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
  }
  if (report.truncated)
    doc.fillColor(MUTED).fontSize(8).text('Only the most recent 5,000 entries are shown. Choose a shorter period to see the rest.', left, y + 4);

  // Footer with page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - 30;
    doc.page.margins.bottom = 0;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(`${report.business.name} · Audit report`, left, bottom, { width: width / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, left + width / 2, bottom, { width: width / 2, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}
