import { toBusinessLocal } from '../lib/time.js';
import type { ExportRow } from './rows.js';

/* ───────────────────────────────── CSV ───────────────────────────────── */

/**
 * One CSV cell. Quoted always (names contain commas), and guarded against
 * formula injection: a customer who calls themselves `=HYPERLINK(...)` must
 * not become a live formula when the owner opens the file in Excel. Leading
 * = + - @ tab and CR are neutralised with an apostrophe, the OWASP advice.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  // A bare number ("+923001234567", "-5") cannot be a formula, so phone numbers
  // keep their "+"; anything else starting with a trigger character is defused.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d ]*$/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

const CSV_HEADER = [
  'Date',
  'Start',
  'End',
  'Status',
  'Service',
  'Staff',
  'Customer',
  'Phone',
  'Price (PKR)',
  'Booked via',
  'Customer confirmed',
  'Follow-up due',
  'Booking ID',
];

export function toCsv(rows: ExportRow[], timezone: string): string {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const r of rows) {
    const start = toBusinessLocal(r.startsAt, timezone);
    const end = toBusinessLocal(r.endsAt, timezone);
    lines.push(
      [
        start.toISODate(),
        start.toFormat('HH:mm'),
        end.toFormat('HH:mm'),
        r.status,
        r.serviceName,
        r.staffName,
        r.clientName ?? 'Walk-in',
        r.clientPhone ? `+${r.clientPhone}` : '',
        (r.priceMinor / 100).toFixed(2),
        r.source,
        r.clientConfirmed ? 'yes' : '',
        r.followUpDueAt ? toBusinessLocal(r.followUpDueAt, timezone).toISODate() : '',
        r.id,
      ]
        .map((v) => csvCell(v))
        .join(','),
    );
  }
  // CRLF per RFC 4180, and a BOM so Excel reads Urdu names as UTF-8.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/* ──────────────────────────────── iCal ───────────────────────────────── */

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function icalText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC basic format: 20300301T060000Z. */
export function icalDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Lines over 75 octets are folded (CRLF + space). Counted in UTF-8 bytes, not
 * characters, and never splitting a multi-byte character.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose one to the space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const ICAL_STATUS: Record<string, string> = {
  confirmed: 'CONFIRMED',
  completed: 'CONFIRMED',
  pending: 'TENTATIVE',
  awaiting_approval: 'TENTATIVE',
  awaiting_deposit: 'TENTATIVE',
  no_show: 'CANCELLED',
  cancelled: 'CANCELLED',
};

export function toIcal(
  rows: ExportRow[],
  opts: { businessName: string; timezone: string; now: Date; host: string },
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scalivo//Appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(`${opts.businessName} — Scalivo`)}`,
    `X-WR-TIMEZONE:${icalText(opts.timezone)}`,
    // Calendar apps poll on their own schedule; this asks for hourly.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const r of rows) {
    const who = r.clientName ?? 'Walk-in';
    const details = [
      `With ${r.staffName}`,
      r.clientPhone ? `Phone: +${r.clientPhone}` : null,
      `Status: ${r.status.replace(/_/g, ' ')}`,
      r.clientConfirmed ? 'Customer confirmed ✅' : null,
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      // Stable per booking, so a reschedule MOVES the event rather than adding one.
      `UID:${r.id}@${opts.host}`,
      `DTSTAMP:${icalDate(opts.now)}`,
      ...(r.updatedAt ? [`LAST-MODIFIED:${icalDate(r.updatedAt)}`] : []),
      `DTSTART:${icalDate(r.startsAt)}`,
      `DTEND:${icalDate(r.endsAt)}`,
      `SUMMARY:${icalText(`${r.serviceName} — ${who}`)}`,
      `DESCRIPTION:${icalText(details)}`,
      `STATUS:${ICAL_STATUS[r.status] ?? 'CONFIRMED'}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
