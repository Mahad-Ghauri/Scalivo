import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import type { EvaluationReport, Rate } from '@scalivo/shared';
import { env } from '../config/env.js';
import { Business } from '../models/Business.js';
import { buildEvaluation } from '../evaluation/report.js';

/**
 * Pull the evaluation metrics — milestone 3.9's "on demand".
 *
 *   pnpm --filter @scalivo/backend evaluate                       # every business, last 90 days
 *   pnpm --filter @scalivo/backend evaluate -- --from 2026-06-01 --to 2026-08-31
 *   pnpm --filter @scalivo/backend evaluate -- --business <id>
 *   pnpm --filter @scalivo/backend evaluate -- --json > results.json
 *
 * A script rather than an HTTP endpoint, deliberately. The consumer is whoever is
 * writing the evaluation chapter, once in a while, from a terminal — not the
 * product. An endpoint would have to be built, authorised, tenant-scoped and then
 * defended, all to serve a reader who already has database access, and every one of
 * those is a surface that can leak one business's figures to another.
 *
 * `--json` exists because Phase 5.4 is the analysis, and it should not have to parse
 * a table meant for a human.
 */

interface Args {
  businessId: string | null;
  from: string;
  to: string;
  json: boolean;
}

/** Long enough to contain a trend, short enough to run against a laptop's Mongo. */
const DEFAULT_DAYS = 90;

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };

  const today = DateTime.utc().toISODate() ?? '';

  return {
    businessId: flag('business'),
    from: flag('from') ?? DateTime.utc().minus({ days: DEFAULT_DAYS }).toISODate() ?? '',
    to: flag('to') ?? today,
    json: argv.includes('--json'),
  };
}

/**
 * A rate, or the reason there isn't one. Never a 0 standing in for "no data".
 *
 * Over 100% is called out rather than hidden. It happens when a numerator and
 * denominator come from different records — web bookings against recorded form
 * starts, where a booking can exist with no start behind it — and printing "300.0%"
 * with no comment invites the reader to treat it as a result. It is a statement about
 * the data, so it is labelled as one.
 */
function pct(rate: Rate): string {
  if (rate.rate === null) return `     —  (no sample)`;

  const value = `${(rate.rate * 100).toFixed(1).padStart(6)}%  (${rate.numerator}/${rate.denominator})`;
  return rate.rate > 1 ? `${value}  ← over 100%: the denominator is under-counted` : value;
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function print(report: EvaluationReport): void {
  const r = report;

  console.log(`
════════════════════════════════════════════════════════════════════
 ${r.businessName}  ·  ${r.from} → ${r.to}  ·  ${r.timezone}
 generated ${r.generatedAt}
════════════════════════════════════════════════════════════════════

NO-SHOW RATE — deposit required vs not (SPEC §12.3)
  with deposit required   ${pct(r.noShow.withDeposit)}
  without                 ${pct(r.noShow.withoutDeposit)}
  difference              ${
    r.noShow.differencePoints === null
      ? '—  (one arm has no sample)'
      : `${r.noShow.differencePoints.toFixed(1)} points ${r.noShow.differencePoints >= 0 ? 'fewer' : 'MORE'} no-shows with a deposit`
  }
  caveat                  ${r.noShow.unpaidWithDeposit} deposit-required appointments reached their hour unpaid

RETENTION CONVERSION — rebooked after a marketing message (SPEC §6.3)
  rebooking nudges        ${pct(r.retention.nudges)}
  broadcasts              ${pct(r.retention.campaigns)}
  replied at all          ${pct(r.retention.replies)}
  excluded                ${r.retention.notSent} never left the building (queued/skipped/failed)
  still open              ${r.retention.unresolved} sent too recently for the 14-day window to have closed
  cold contacts           ${r.retention.coldContacts} had never messaged this business (FINDING #3)

BOOKING COMPLETION — WhatsApp vs web
  WhatsApp flows          ${pct(r.completion.whatsapp)}
  web form starts         ${pct(r.completion.web)}
  reschedules             ${pct(r.completion.whatsappReschedules)}
  still open              ${r.completion.whatsappOpen} mid-booking right now (in neither half)
  menu gave up            ${r.completion.whatsappEscalated} handed to a human after 3 misreads
  left deliberately       ${r.completion.whatsappLeft} typed STOP/CANCEL or asked for a person (excluded)
  messages per booking    ${r.completion.messagesPerBooking?.toFixed(1) ?? '—'}
  misreads per flow       ${r.completion.invalidInputsPerFlow?.toFixed(2) ?? '—'}
  by entry point${
    r.completion.byOpener.length === 0
      ? '          —'
      : `\n${r.completion.byOpener
          .map(
            (o) =>
              `      ${o.opener.padEnd(22)} ${pct(o.flows)}` +
              `   ${o.messagesPerBooking?.toFixed(1) ?? '—'} msgs` +
              `, ${o.invalidInputsPerFlow?.toFixed(2) ?? '—'} misreads`,
          )
          .join('\n')}\n      (customers chose their entry point — a difference here is not a controlled result)`
  }
  drop-off${
    r.completion.whatsappDropOff.length === 0
      ? '                —'
      : `\n${r.completion.whatsappDropOff.map((d) => `      ${d.state.padEnd(22)} ${d.flows}`).join('\n')}`
  }

SESSION UPTIME — the headline metric
  uptime                  ${pct({ numerator: r.uptime.upMs, denominator: r.uptime.upMs + r.uptime.downMs, rate: r.uptime.rate })}
  up / down               ${hours(r.uptime.upMs)} up, ${hours(r.uptime.downMs)} down
  untracked               ${hours(r.uptime.untrackedMs)} neither (stopped by us, mid-link, or before records began)
  outages                 ${r.uptime.outages}, longest ${hours(r.uptime.longestOutageMs)}
  measured                ${r.uptime.measuredFrom ?? 'never linked — no uptime to report'} → ${r.uptime.measuredTo}
  sessions${
    r.uptime.sessions.length === 0
      ? '                —'
      : `\n${r.uptime.sessions
          .map(
            (s) =>
              `      ${s.sessionId.padEnd(24)} ${hours(s.upMs)} up, ${hours(s.downMs)} down, ${s.outages} outages${s.current ? '  (current)' : ''}`,
          )
          .join('\n')}`
  }

ADOPTION — bookings per week, automated vs manual
  total                   ${r.adoption.total}
  automated share         ${pct(r.adoption.automatedShare)}
  by source               ${r.adoption.automated} customer-made, ${r.adoption.manual} owner-entered
  weekly${
    r.adoption.weeks.length === 0
      ? '                  —'
      : `\n${r.adoption.weeks
          .map(
            (w) =>
              `      ${w.from}  ${String(w.bookings).padStart(3)} total   wa ${w.whatsapp}  web ${w.web}  owner ${w.owner}`,
          )
          .join('\n')}`
  }

REVIEW CAPTURE — SPEC §9
  asked                   ${pct(r.reviews.requested)} of completed appointments
  captured                ${pct(r.reviews.captured)} of requests sent
  average rating          ${r.reviews.averageRating?.toFixed(2) ?? '—'}
  distribution            ${r.reviews.distribution.map((count, i) => `${i + 1}★ ${count}`).join('   ')}
  published               ${r.reviews.published} visible publicly (4–5★)

AGENT ENGAGEMENT — milestone 3.4's input
  briefings               ${r.agent.briefings}
  opened                  ${pct(r.agent.read)}
  phrased by Gemini       ${pct(r.agent.phrasedByLlm)} (the rest fell back to templates)
${r.agent.byKind.map((k) => `      ${k.kind.padEnd(22)} ${pct(k.read)}`).join('\n')}
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(env.MONGO_URI);

  const businesses = args.businessId
    ? [args.businessId]
    : (await Business.find().select('_id')).map((business) => String(business._id));

  if (businesses.length === 0) {
    console.error('no businesses found');
    process.exit(1);
  }

  const reports: EvaluationReport[] = [];

  for (const businessId of businesses) {
    // One at a time, and a failure names the business rather than aborting the run:
    // "the whole set works" is the claim being tested, and the useful output of a
    // broken metric is which business and which metric, not an empty terminal.
    try {
      reports.push(await buildEvaluation(businessId, args.from, args.to));
    } catch (err) {
      console.error(`\n  ${businessId}: could not build the report —`, err);
    }
  }

  if (args.json) console.log(JSON.stringify(reports, null, 2));
  else for (const report of reports) print(report);

  await mongoose.disconnect();

  // A run that produced nothing has not proven anything, and must not look like it
  // did. This is the exit code CI would key on.
  if (reports.length === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
