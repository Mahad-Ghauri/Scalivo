import { DateTime } from 'luxon';
import { z } from 'zod';
import type {
  ClientImportOutcome,
  ClientImportResult,
  ClientImportRowResult,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { normalisePhone } from '../lib/phone.js';
import { logger } from '../lib/logger.js';
import { recomputeProfile } from './profile.js';

/**
 * Bulk customer import — milestone 2.7.
 *
 * The point is that retention has something to work with on day one. A salon
 * moving over has years of regulars; without this, every one of them looks
 * like a stranger until they happen to book again, and the LAPSED customers —
 * the ones win-back exists for — never book again, so they never appear.
 *
 * Three rules carry the design:
 *
 *   1. **The phone is the only key.** It is what an inbound WhatsApp message is
 *      eventually matched on, so a row without one cannot be deduped against
 *      anything, and a second import would create every such person twice. A
 *      phone-less row is refused, not created.
 *
 *   2. **Match, don't duplicate.** Someone who has already messaged the
 *      business on WhatsApp exists as a Client; the import links them rather
 *      than creating a second person with the same number. That split is the
 *      exact failure normalisePhone exists to prevent.
 *
 *   3. **History is a baseline, never a counter bump.** It lives in
 *      `profile.imported` and the counters are recomputed from bookings plus
 *      that baseline — so re-importing the same file replaces the history
 *      instead of doubling everybody's visits.
 */

/** Blank cells arrive as '' from a spreadsheet; they mean "not given". */
const blank = (value: unknown) => (value === '' || value === null ? undefined : value);

/** "Rs. 12,500" and "12500" are the same number to the person who typed them. */
const amount = (value: unknown) => {
  const v = blank(value);
  return typeof v === 'string' ? Number(v.replace(/rs\.?|pkr|[,\s]/gi, '')) : v;
};

const rowSchema = z.object({
  phone: z.string({ required_error: 'no phone number' }),
  name: z.preprocess(blank, z.string().trim().max(120).optional()),
  visits: z.preprocess(amount, z.number({ invalid_type_error: 'visits is not a number' }).int('visits must be a whole number').min(0).max(10_000).optional()),
  spend: z.preprocess(amount, z.number({ invalid_type_error: 'spend is not a number' }).min(0).max(1_000_000_000).optional()),
  firstVisit: z.preprocess(blank, z.string().optional()),
  lastVisit: z.preprocess(blank, z.string().optional()),
});

/**
 * A visit date in the business's calendar, or an error message.
 *
 * DD/MM/YYYY is read the Pakistani way round and MM/DD is never guessed at:
 * 03/04 is the 3rd of April here, and a parser that "helpfully" tried both
 * would put half a salon's history in the wrong month without a word. Noon,
 * not midnight, so no timezone conversion can tip it into the previous day.
 */
function parseVisitDate(input: string, timezone: string, now: Date): Date | string {
  const text = input.trim();
  let parts: { year: number; month: number; day: number } | null = null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (iso) parts = { year: +iso[1]!, month: +iso[2]!, day: +iso[3]! };
  else if (local) parts = { year: +local[3]!, month: +local[2]!, day: +local[1]! };

  if (!parts) return `"${text}" is not a date — use DD/MM/YYYY or YYYY-MM-DD`;

  const date = DateTime.fromObject({ ...parts, hour: 12 }, { zone: timezone });
  if (!date.isValid) return `"${text}" is not a real date`;
  if (date.toJSDate() > now) return `"${text}" is in the future`;
  return date.toUTC().toJSDate();
}

interface ValidRow {
  row: number;
  phone: string;
  name: string | null;
  visits: number;
  spendMinor: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
}

type Checked = { ok: true; value: ValidRow } | { ok: false; phone: string | null; reason: string };

function checkRow(raw: unknown, row: number, timezone: string, now: Date): Checked {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, phone: null, reason: parsed.error.issues[0]?.message ?? 'unreadable row' };
  }
  const data = parsed.data;

  if (data.phone.trim() === '') return { ok: false, phone: null, reason: 'no phone number' };
  const phone = normalisePhone(data.phone);
  if (!phone) return { ok: false, phone: null, reason: `"${data.phone}" is not a phone number` };

  const first = data.firstVisit ? parseVisitDate(data.firstVisit, timezone, now) : null;
  if (typeof first === 'string') return { ok: false, phone, reason: first };
  const last = data.lastVisit ? parseVisitDate(data.lastVisit, timezone, now) : null;
  if (typeof last === 'string') return { ok: false, phone, reason: last };

  if (first && last && first > last) {
    return { ok: false, phone, reason: 'first visit is after the last visit' };
  }

  // A last-visit date IS a visit, whatever the count column says.
  const visits = Math.max(data.visits ?? 0, last || first ? 1 : 0);

  return {
    ok: true,
    value: {
      row,
      phone,
      name: data.name || null,
      visits,
      spendMinor: Math.round((data.spend ?? 0) * 100),
      // One date given is both ends of the history, not a gap of zero days
      // from nothing. averageGapDays reads first == last as "no pattern yet".
      firstVisitAt: first ?? last,
      lastVisitAt: last ?? first,
    },
  };
}

export async function importClients(input: {
  businessId: string;
  timezone: string;
  rows: unknown[];
  dryRun: boolean;
  now?: Date;
}): Promise<ClientImportResult> {
  const { businessId, timezone, dryRun } = input;
  const now = input.now ?? new Date();

  const results: ClientImportRowResult[] = [];
  const valid: ValidRow[] = [];
  const seen = new Map<string, number>();

  input.rows.forEach((raw, row) => {
    const checked = checkRow(raw, row, timezone, now);
    if (!checked.ok) {
      results.push({ row, outcome: 'invalid', phone: checked.phone, reason: checked.reason });
      return;
    }
    const earlier = seen.get(checked.value.phone);
    if (earlier !== undefined) {
      // First occurrence wins. Merging two rows' visit counts would be a guess
      // about whether the owner's list double-entered someone or not.
      results.push({
        row,
        outcome: 'duplicate',
        phone: checked.value.phone,
        reason: 'same number as an earlier row',
        duplicateOf: earlier,
      });
      return;
    }
    seen.set(checked.value.phone, row);
    valid.push(checked.value);
  });

  // Who already exists, and who is already this business's customer — two
  // queries for the whole file rather than two per row.
  const phones = valid.map((v) => v.phone);
  const existing = await Client.find({ phone: { $in: phones } }).select('_id phone');
  const idByPhone = new Map(existing.map((c) => [c.phone!, String(c._id)]));
  const profiled = new Set(
    (
      await ClientProfile.find({ businessId, clientId: { $in: [...idByPhone.values()] } }).select(
        'clientId',
      )
    ).map((p) => p.clientId),
  );

  for (const v of valid) {
    const id = idByPhone.get(v.phone);
    const outcome: ClientImportOutcome = !id ? 'created' : profiled.has(id) ? 'updated' : 'linked';
    results.push({ row: v.row, outcome, phone: v.phone });
  }
  results.sort((a, b) => a.row - b.row);

  const counts: Record<ClientImportOutcome, number> = {
    created: 0,
    linked: 0,
    updated: 0,
    duplicate: 0,
    invalid: 0,
  };
  for (const r of results) counts[r.outcome] += 1;

  if (dryRun || valid.length === 0) return { dryRun, counts, rows: results };

  // People. An upsert on the phone rather than an insert, so a customer who
  // messages on WhatsApp between the preview and the import is matched, not
  // collided with. The name is only ever backfilled: the WhatsApp display name
  // is the customer's own, and a spreadsheet's spelling is not an improvement.
  await Client.bulkWrite(
    valid.flatMap((v) => [
      {
        updateOne: {
          filter: { phone: v.phone },
          update: { $setOnInsert: { phone: v.phone, displayName: v.name } },
          upsert: true,
        },
      },
      ...(v.name
        ? [
            {
              updateOne: {
                filter: { phone: v.phone, displayName: null },
                update: { $set: { displayName: v.name } },
              },
            },
          ]
        : []),
    ]),
    { ordered: true },
  );

  const clients = await Client.find({ phone: { $in: phones } }).select('_id phone');
  const clientIdByPhone = new Map(clients.map((c) => [c.phone!, String(c._id)]));

  // Anyone with bookings here needs a real recompute; everyone else's counters
  // are exactly the baseline, and can be written in the same bulk operation.
  const withBookings = new Set(
    (await Booking.distinct('clientId', {
      businessId,
      clientId: { $in: [...clientIdByPhone.values()] },
    })) as string[],
  );

  await ClientProfile.bulkWrite(
    valid.map((v) => {
      const clientId = clientIdByPhone.get(v.phone)!;
      const imported = {
        visits: v.visits,
        spendMinor: v.spendMinor,
        firstVisitAt: v.firstVisitAt,
        lastVisitAt: v.lastVisitAt,
        importedAt: now,
      };
      return {
        updateOne: {
          filter: { businessId, clientId },
          update: {
            $setOnInsert: { businessId, clientId },
            $set: withBookings.has(clientId)
              ? { imported }
              : {
                  imported,
                  totalVisits: v.visits,
                  lifetimeSpendMinor: v.spendMinor,
                  firstVisitAt: v.firstVisitAt,
                  lastVisitAt: v.lastVisitAt,
                },
          },
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );

  for (const clientId of withBookings) await recomputeProfile(businessId, clientId);

  logger.info({ businessId, ...counts }, 'clients imported');
  return { dryRun, counts, rows: results };
}
