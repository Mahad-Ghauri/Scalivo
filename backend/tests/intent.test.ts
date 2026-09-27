import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_OPENER, FLOW_OUTCOME, type FlowOpener } from '@scalivo/shared';
import {
  hasBookingDetail,
  isUseful,
  localMinutes,
  parseIntent,
  readIntentJson,
  resolveIntent,
  worthLooking,
  type RawIntent,
  type Vocabulary,
} from '../src/whatsapp/fsm/intent.js';
import { advance, resumeFromIntent } from '../src/whatsapp/fsm/machine.js';
import { CONVERSATION_STATE, type Conversation } from '../src/whatsapp/fsm/states.js';
import { recordFlowStep } from '../src/whatsapp/flow-run.js';
import { completionMetric } from '../src/evaluation/metrics.js';
import { getAvailability } from '../src/bookings/availability.js';
import { Business } from '../src/models/Business.js';
import { FlowRun } from '../src/models/FlowRun.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { infraReady } from './infra.js';

/**
 * Free-text booking — milestone 3.2.
 *
 * The suite is split the way the feature is: the parts that decide things are pure
 * and tested exhaustively without a network, and only the ladder that walks a
 * resolved intent into the menu needs infrastructure.
 *
 * **Nothing here calls Gemini.** That is deliberate and not a gap. The model's whole
 * contribution is a JSON object, so a test that produced one would be testing
 * Google's uptime; every decision made about that object — which service it names,
 * whether that staff member exists, which Saturday "saturday" is, and where in the
 * menu the customer lands — is made by code in this repo and is checked here against
 * intents written by hand. The one thing worth knowing about the real call is that
 * its absence is survivable, and `degrading without a model` proves that end to end.
 */

const TZ = 'Asia/Karachi';

// ---------------------------------------------------------------------------
// Pure: the gate
// ---------------------------------------------------------------------------

const VOCABULARY: Vocabulary = {
  services: [
    { id: 'svc-hydra', name: 'Hydrafacial' },
    { id: 'svc-deep', name: 'Deep Cleansing Facial' },
    { id: 'svc-laser', name: 'Laser Hair Removal' },
  ],
  staff: [
    { id: 'stf-ayesha', name: 'Dr. Ayesha', serviceIds: ['svc-hydra', 'svc-deep'] },
    { id: 'stf-sana', name: 'Sana', serviceIds: ['svc-laser'] },
  ],
};

describe('the gate — what is worth asking a model about', () => {
  it('refuses a bare number, which is a menu reply from a timed-out conversation', () => {
    expect(worthLooking('2')).toBe(false);
    expect(hasBookingDetail('2', VOCABULARY)).toBe(false);
  });

  it('refuses anything longer than a booking request could be', () => {
    expect(worthLooking('x'.repeat(301))).toBe(false);
  });

  it('lets a bare greeting through to the menu without a model call', () => {
    // The commonest message there is. Parsing it would cost a second of latency on
    // every conversation that has ever started, for the same service menu.
    expect(hasBookingDetail('hi', VOCABULARY)).toBe(false);
    expect(hasBookingDetail('assalam o alaikum', VOCABULARY)).toBe(false);
    expect(hasBookingDetail('i want to book', VOCABULARY)).toBe(false);
  });

  it('fires on a day word', () => {
    expect(hasBookingDetail('anything on saturday?', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('kal koi slot hai', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('tomorrow please', VOCABULARY)).toBe(true);
  });

  it('fires on a time of day or a clock time', () => {
    expect(hasBookingDetail('something in the afternoon', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('can i come at 3:30', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('4 pm works', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('shaam mein', VOCABULARY)).toBe(true);
  });

  it('fires on a partial service or staff name', () => {
    // "facial" is inside "Hydrafacial" — someone naming a real thing imprecisely.
    expect(hasBookingDetail('facial please', VOCABULARY)).toBe(true);
    expect(hasBookingDetail('ayesha available?', VOCABULARY)).toBe(true);
  });

  it('stays quiet on chatter that names nothing', () => {
    expect(hasBookingDetail('do you have parking', VOCABULARY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: reading the model's reply
// ---------------------------------------------------------------------------

describe("the model's reply", () => {
  const empty: RawIntent = { service: null, staff: null, day: null, window: null, at: null };

  it('reads a clean object', () => {
    expect(readIntentJson('{"service":"Hydrafacial","staff":null,"day":"saturday","window":"afternoon","at":null}'))
      .toEqual({ service: 'Hydrafacial', staff: null, day: 'saturday', window: 'afternoon', at: null });
  });

  it('survives the markdown fences models add anyway', () => {
    const fenced = '```json\n{"service":"Laser Hair Removal","staff":null,"day":null,"window":null,"at":null}\n```';
    expect(readIntentJson(fenced)?.service).toBe('Laser Hair Removal');
  });

  it('survives a preamble', () => {
    expect(readIntentJson('Here is the JSON: {"service":"Hydrafacial"} — hope that helps')?.service)
      .toBe('Hydrafacial');
  });

  it('unwraps a single object a model put in an array', () => {
    // The same tolerance as the fences: the object is there, and the brackets are
    // formatting. Two objects are not, and fail to parse below.
    expect(readIntentJson('[{"service":"Hydrafacial","staff":null,"day":null,"window":null,"at":null}]')?.service)
      .toBe('Hydrafacial');
  });

  it('rejects anything that is not one object', () => {
    expect(readIntentJson('sorry, I cannot help with that')).toBeNull();
    expect(readIntentJson('{not json at all}')).toBeNull();
    expect(readIntentJson('[{"service":"Hydrafacial"},{"service":"Laser Hair Removal"}]')).toBeNull();
    // Truncated by the output cap.
    expect(readIntentJson('{"service":"Hydra')).toBeNull();
  });

  it('treats a non-string or blank field as absent rather than failing the parse', () => {
    // A model that answers `"day": 6` has still read the service correctly, and
    // throwing the whole intent away over one field would cost more than it saves.
    const mixed = readIntentJson('{"service":"Hydrafacial","staff":"","day":6,"window":null,"at":null}');
    expect(mixed).toEqual({ ...empty, service: 'Hydrafacial' });
  });
});

// ---------------------------------------------------------------------------
// Pure: resolution
// ---------------------------------------------------------------------------

describe('resolution — nothing the model says is taken on trust', () => {
  /** A Wednesday, so weekday arithmetic has somewhere to go in both directions. */
  const NOW = new Date('2026-09-30T08:00:00.000Z');

  const resolve = (raw: Partial<RawIntent>) =>
    resolveIntent(
      { service: null, staff: null, day: null, window: null, at: null, ...raw },
      { ...VOCABULARY, timezone: TZ, now: NOW },
    );

  it('matches a service by its exact name', () => {
    expect(resolve({ service: 'Hydrafacial' }).serviceId).toBe('svc-hydra');
  });

  it('matches a service by a fragment of its name', () => {
    expect(resolve({ service: 'laser' }).serviceId).toBe('svc-laser');
  });

  it('will not choose between two services a fragment fits', () => {
    // "facial" is in both Hydrafacial and Deep Cleansing Facial. Picking the first
    // would book the wrong treatment; the candidates become a shorter menu instead.
    const resolved = resolve({ service: 'facial' });
    expect(resolved.serviceId).toBeNull();
    expect(resolved.serviceOptions).toHaveLength(2);
    expect(resolved.serviceOptions).toContain('svc-hydra');
    expect(resolved.serviceOptions).toContain('svc-deep');
  });

  it('resolves an invented service to nothing', () => {
    // The guard that matters: a hallucinated name must not reach the database.
    expect(resolve({ service: 'Botox' }).serviceId).toBeNull();
    expect(resolve({ service: 'Botox' }).serviceOptions).toEqual([]);
  });

  it('honours a staff member who can perform the service', () => {
    expect(resolve({ service: 'Hydrafacial', staff: 'ayesha' }).staffId).toBe('stf-ayesha');
  });

  it('refuses a staff member who cannot perform it', () => {
    // Sana does laser only. A preference we cannot honour is not a preference, and
    // carrying it would produce an appointment with an unqualified staff member.
    expect(resolve({ service: 'Hydrafacial', staff: 'Sana' }).staffId).toBeNull();
  });

  it('refuses an invented staff member', () => {
    expect(resolve({ service: 'Hydrafacial', staff: 'Fatima' }).staffId).toBeNull();
  });

  it('drops a staff preference when no service resolved', () => {
    // It would otherwise be applied to whatever they pick from the menu next, which
    // is not what they asked for — and may be something that person cannot do.
    expect(resolve({ service: 'facial', staff: 'ayesha' }).staffId).toBeNull();
  });

  it('resolves today and tomorrow in the business\'s own zone', () => {
    // 08:00 UTC is 13:00 in Karachi — the same day. A naive UTC read would be right
    // here by luck, so the zone is what the following weekday cases lean on.
    expect(resolve({ day: 'today' }).date).toBe('2026-09-30');
    expect(resolve({ day: 'tomorrow' }).date).toBe('2026-10-01');
    expect(resolve({ day: 'kal' }).date).toBe('2026-10-01');
  });

  it('resolves a weekday forwards, never backwards', () => {
    // Wednesday 30 September 2026. Saturday is the 3rd of October, not the 26th of
    // September — the failure a model doing its own date arithmetic would produce.
    expect(resolve({ day: 'saturday' }).date).toBe('2026-10-03');
    expect(resolve({ day: 'sat' }).date).toBe('2026-10-03');
    expect(resolve({ day: 'monday' }).date).toBe('2026-10-05');
  });

  it('reads a weekday that is today as today', () => {
    // Someone saying "wednesday" on a Wednesday morning means this afternoon. Any
    // slot already past is dropped by availability, not here.
    expect(resolve({ day: 'wednesday' }).date).toBe('2026-09-30');
  });

  it('keeps a future date and discards one already gone', () => {
    expect(resolve({ day: '2026-10-15' }).date).toBe('2026-10-15');
    // We do not know which future date they meant, so the date menu asks.
    expect(resolve({ day: '2026-09-01' }).date).toBeNull();
  });

  it('ignores a day it cannot make sense of', () => {
    expect(resolve({ day: 'sometime soon' }).date).toBeNull();
    expect(resolve({ day: 'next week' }).date).toBeNull();
  });

  it('turns a named time of day into a range with words to say it back', () => {
    const afternoon = resolve({ window: 'afternoon' }).within;
    expect(afternoon).toEqual({ from: 12 * 60, to: 17 * 60, label: 'in the afternoon' });
    expect(resolve({ window: 'morning' }).within?.to).toBe(12 * 60);
  });

  it('turns a clock time into an open-ended window and keeps the exact minute', () => {
    const resolved = resolve({ at: '15:30' });
    expect(resolved.at).toBe(15 * 60 + 30);
    expect(resolved.within?.from).toBe(15 * 60 + 30);
    expect(resolved.within?.label).toBe('from 3:30 PM');
  });

  it('lets a named window win over a clock time', () => {
    // The coarser claim. Showing a range beats implying we found their exact time.
    expect(resolve({ window: 'morning', at: '15:00' }).within?.to).toBe(12 * 60);
  });

  it('ignores a clock time that is not one', () => {
    expect(resolve({ at: 'afternoon' }).at).toBeNull();
    expect(resolve({ at: '25:00' }).at).toBeNull();
    expect(resolve({ at: '12:75' }).at).toBeNull();
  });

  it('counts a bare day as useful and an empty intent as not', () => {
    expect(isUseful(resolve({ day: 'saturday' }))).toBe(true);
    expect(isUseful(resolve({ window: 'evening' }))).toBe(true);
    expect(isUseful(resolve({}))).toBe(false);
    expect(isUseful(resolve({ service: 'Botox', staff: 'Nobody' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Infrastructure: the ladder, and what it records
// ---------------------------------------------------------------------------

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('the ladder — where a sentence drops the customer', () => {
  let redis: Redis;
  let businessId: string;
  let clientId: string;
  let vocabulary: Vocabulary;
  let hydra: string;
  let ayesha: string;

  /** Tomorrow, so every slot in the business's day is still ahead of the notice period. */
  const day = (): string =>
    DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate() ?? '';

  function context(conversation: Conversation | null = null) {
    return {
      businessId,
      businessName: 'Intent Test Salon',
      timezone: TZ,
      clientId,
      firstName: 'Sana',
      text: 'irrelevant — the ladder is given a resolved intent',
      conversation,
    };
  }

  const intent = (over: Partial<Parameters<typeof resumeFromIntent>[2]> = {}) => ({
    serviceId: null,
    serviceOptions: [],
    staffId: null,
    date: null,
    within: null,
    at: null,
    ...over,
  });

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 10 });
    await SlotOccupancy.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'intent-test' },
      {
        slug: 'intent-test',
        name: 'Intent Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        whatsapp: { sessionId: 'test-session-intent' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);
    clientId = 'client-intent-test';

    await Promise.all([
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
      FlowRun.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    // Two services containing "facial", so an ambiguous fragment has somewhere to go.
    const [a, b, c] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000, displayOrder: 1 },
      { businessId, name: 'Deep Cleansing Facial', durationMinutes: 30, priceMinor: 500_000, displayOrder: 2 },
      { businessId, name: 'Laser Hair Removal', durationMinutes: 20, priceMinor: 600_000, displayOrder: 3 },
    ]);
    hydra = String(a!._id);

    // Open every day, so the suite does not only pass on weekdays.
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));

    const [one, two] = await Staff.insertMany([
      { businessId, name: 'Dr. Ayesha', serviceIds: [hydra, String(b!._id)], workingHours: hours },
      { businessId, name: 'Sana', serviceIds: [hydra, String(c!._id)], workingHours: hours },
    ]);
    ayesha = String(one!._id);

    vocabulary = {
      services: [
        { id: hydra, name: 'Hydrafacial' },
        { id: String(b!._id), name: 'Deep Cleansing Facial' },
        { id: String(c!._id), name: 'Laser Hair Removal' },
      ],
      staff: [
        { id: ayesha, name: 'Dr. Ayesha', serviceIds: [hydra, String(b!._id)] },
        { id: String(two!._id), name: 'Sana', serviceIds: [hydra, String(c!._id)] },
      ],
    };
  });

  it('asks who, when only the service was named', async () => {
    const result = await resumeFromIntent(redis, context(), intent({ serviceId: hydra }), vocabulary);

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_STAFF);
    // The service menu is skipped, and the echo says what was understood.
    expect(result.replies[0]).toContain('Hydrafacial');
    expect(result.replies.join('\n')).toContain('Dr. Ayesha');
  });

  it('skips the service AND staff menus when both were named', async () => {
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, staffId: ayesha }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_DATE);
    expect(result.replies[0]).toContain('with Dr. Ayesha');
  });

  it('goes straight to times when the service, the person and the day were all named', async () => {
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, staffId: ayesha, date: day() }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
    expect(result.conversation?.date).toBe(day());
    expect(result.replies.join('\n')).toContain('Available times');
  });

  it('offers only the times inside the window the customer asked for', async () => {
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({
        serviceId: hydra,
        staffId: ayesha,
        date: day(),
        within: { from: 12 * 60, to: 17 * 60, label: 'in the afternoon' },
      }),
      vocabulary,
    );

    const offered = result.conversation?.options ?? [];
    expect(offered.length).toBeGreaterThan(0);
    for (const iso of offered) {
      const minutes = localMinutes(new Date(iso), TZ);
      expect(minutes).toBeGreaterThanOrEqual(12 * 60);
      expect(minutes).toBeLessThan(17 * 60);
    }
    // The business opens at 09:00, so filtering actually removed something.
    expect(result.replies[0]).toContain('in the afternoon');
  });

  it('widens an empty window rather than showing an empty list, and says so', async () => {
    // The business closes at 18:00, so nothing is free in the evening — but the day
    // itself has room, and a dead end here would be the bot ignoring them silently.
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({
        serviceId: hydra,
        staffId: ayesha,
        date: day(),
        within: { from: 20 * 60, to: 23 * 60, label: 'in the evening' },
      }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
    expect((result.conversation?.options ?? []).length).toBeGreaterThan(0);
    expect(result.replies.join('\n')).toContain('Nothing free in the evening');
    // Dropped, so nothing later in the conversation keeps promising it.
    expect(result.conversation?.within).toBeUndefined();
  });

  it('confirms directly when the customer named a time that is free', async () => {
    const slots = await getAvailability(redis, {
      businessId,
      serviceId: hydra,
      date: day(),
      staffId: ayesha,
    });
    const target = slots[0]!.startsAt;
    const at = localMinutes(target, TZ);

    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, staffId: ayesha, date: day(), at, within: { from: at, to: 24 * 60, label: 'x' } }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.CONFIRMING);
    expect(result.conversation?.slotStart).toBe(target.toISOString());
    expect(result.replies.join('\n')).toContain('Please confirm');
    // Still a YES away. The parse never books.
    expect(result.confirms).toBeUndefined();
  });

  it('falls back to a time list when the named time is not free', async () => {
    // 09:05 is not on a 15-minute grid, so no slot can start there.
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, staffId: ayesha, date: day(), at: 9 * 60 + 5 }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
  });

  it('will not choose a staff member on the customer\'s silence, even knowing the day', async () => {
    // Two people can do a Hydrafacial and the sentence named neither. Assigning one
    // would be a trap: the confirmation names them and a NO goes back to times, so
    // there would be no route to anybody else.
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, date: day(), at: 10 * 60 }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_STAFF);
    // And the day survives the question it was not asked about.
    expect(result.conversation?.date).toBe(day());
  });

  it('carries the day through the staff answer instead of asking for it again', async () => {
    const asked = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceId: hydra, date: day() }),
      vocabulary,
    );
    expect(asked.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_STAFF);

    // "1" — the first staff member on the list they were just shown.
    const answered = await advance(redis, { ...context(asked.conversation), text: '1' });

    expect(answered.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
    expect(answered.replies.join('\n')).not.toContain('Which day');
  });

  it('narrows the service menu to the candidates a fragment fits', async () => {
    const result = await resumeFromIntent(
      redis,
      context(),
      intent({ serviceOptions: [hydra, vocabulary.services[1]!.id] }),
      vocabulary,
    );

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
    expect(result.conversation?.options).toHaveLength(2);
    const menu = result.replies.join('\n');
    expect(menu).toContain('Hydrafacial');
    expect(menu).toContain('Deep Cleansing Facial');
    expect(menu).not.toContain('Laser Hair Removal');
  });

  it('keeps a bare day alive through the full service menu', async () => {
    // "anything on saturday" resolves no service, so the menu is shown in full —
    // but the day is not asked for twice.
    const shown = await resumeFromIntent(redis, context(), intent({ date: day() }), vocabulary);
    expect(shown.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
    expect(shown.conversation?.options).toHaveLength(3);
    expect(shown.conversation?.date).toBe(day());

    // Picking Hydrafacial then lands on staff, and after that on times — never dates.
    const picked = await advance(redis, { ...context(shown.conversation), text: '1' });
    expect(picked.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_STAFF);

    const timed = await advance(redis, { ...context(picked.conversation), text: '1' });
    expect(timed.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
  });

  it('marks the conversation as free-text opened', async () => {
    const result = await resumeFromIntent(redis, context(), intent({ serviceId: hydra }), vocabulary);
    expect(result.conversation?.opener).toBe(FLOW_OPENER.FREE_TEXT);
  });

  it('degrades to the menu with no model available', async () => {
    // No GEMINI_API_KEY in the test environment, so parseIntent short-circuits. The
    // message is full of detail and still gets the ordinary greeting and menu —
    // which is exactly what a tenant without a key must see.
    expect(process.env.GEMINI_API_KEY).toBeFalsy();
    expect(await parseIntent('hydrafacial with ayesha on saturday afternoon', vocabulary)).toBeNull();

    const result = await advance(redis, {
      ...context(),
      text: 'hydrafacial with ayesha on saturday afternoon',
    });

    expect(result.conversation?.state).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
    expect(result.conversation?.options).toHaveLength(3);
    expect(result.conversation?.opener).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Infrastructure: what the funnel records, and what the report makes of it
// ---------------------------------------------------------------------------

describe.skipIf(!infraUp)('the funnel, split by entry point', () => {
  const businessId = 'business-opener-test';
  const NOW = new Date('2026-09-30T12:00:00.000Z');

  const booking = (state: Conversation['state'], opener?: FlowOpener): Conversation => ({
    state,
    invalidCount: 0,
    ...(opener ? { opener } : {}),
  });

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI!);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([
      FlowRun.deleteMany({ businessId }),
      Business.findOneAndUpdate(
        { slug: 'opener-test' },
        { slug: 'opener-test', name: 'Opener Test', category: 'salon', timezone: TZ },
        { upsert: true, setDefaultsOnInsert: true },
      ),
    ]);
  });

  /**
   * The completion metric, asked an hour later — by which time every flow above is
   * stale, so the ones left open count as abandoned rather than still running.
   */
  const report = () => {
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    return completionMetric({
      businessId,
      timezone: TZ,
      from: new Date(NOW.getTime() - 86_400_000),
      to: later,
      fromDay: '2026-09-29',
      toDay: '2026-10-01',
      now: later,
    });
  };

  /** One flow, opened and then closed, as the router would drive it. */
  async function flow(opener: FlowOpener | undefined, outcome: 'booked' | 'abandoned') {
    const opened = booking(CONVERSATION_STATE.SELECTING_SLOT, opener);
    await recordFlowStep({ businessId, clientId: `c-${Math.random()}`, before: null, after: opened, at: NOW });

    if (outcome === 'booked') {
      // The committing turn clears the conversation — which is why the recorder has
      // to read the opener off `before` as well.
      const clients = await FlowRun.find({ businessId, outcome: null }).sort({ createdAt: -1 }).limit(1);
      await recordFlowStep({
        businessId,
        clientId: clients[0]!.clientId,
        before: opened,
        after: null,
        bookingId: `bk-${Math.random()}`,
        at: NOW,
      });
    }
  }

  it('defaults a conversation that never said how it opened to the menu', async () => {
    await flow(undefined, 'booked');
    const row = await FlowRun.findOne({ businessId });
    expect(row?.opener).toBe(FLOW_OPENER.MENU);
  });

  it('records a free-text flow as one, and keeps it through the committing turn', async () => {
    await flow(FLOW_OPENER.FREE_TEXT, 'booked');
    const row = await FlowRun.findOne({ businessId });
    expect(row?.opener).toBe(FLOW_OPENER.FREE_TEXT);
    expect(row?.outcome).toBe(FLOW_OUTCOME.BOOKED);
  });

  it('counts a flow recorded before the field existed as a menu flow', async () => {
    // Not a hypothetical: the tenant already has months of these. A Mongoose default
    // applies on create and never retroactively, so these rows carry no `opener` at
    // all — and matched by equality they would vanish from the menu arm, leaving the
    // comparison to run against however much traffic arrived after the field was
    // added. The raw driver is used because Mongoose would helpfully supply the
    // default and the test would stop testing anything.
    await FlowRun.collection.insertOne({
      businessId,
      clientId: 'c-legacy',
      startedAt: NOW,
      lastStepAt: NOW,
      startedState: CONVERSATION_STATE.SELECTING_SLOT,
      furthestState: CONVERSATION_STATE.SELECTING_SLOT,
      kind: 'new',
      steps: 4,
      invalidInputs: 0,
      outcome: FLOW_OUTCOME.BOOKED,
      bookingId: 'bk-legacy',
    });

    const row = await FlowRun.collection.findOne({ clientId: 'c-legacy' });
    expect(row?.opener).toBeUndefined();

    const metric = await report();

    expect(metric.whatsapp.denominator).toBe(1);
    expect(metric.byOpener).toHaveLength(1);
    expect(metric.byOpener[0]?.opener).toBe(FLOW_OPENER.MENU);
    expect(metric.byOpener[0]?.flows).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it('reports each entry point separately and omits one with no flows', async () => {
    await flow(FLOW_OPENER.MENU, 'booked');
    await flow(FLOW_OPENER.MENU, 'abandoned');
    await flow(FLOW_OPENER.MENU, 'abandoned');
    await flow(FLOW_OPENER.FREE_TEXT, 'booked');

    const metric = await report();

    expect(metric.whatsapp).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });

    const menu = metric.byOpener.find((o) => o.opener === FLOW_OPENER.MENU);
    const free = metric.byOpener.find((o) => o.opener === FLOW_OPENER.FREE_TEXT);

    expect(menu?.flows).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    expect(free?.flows).toEqual({ numerator: 1, denominator: 1, rate: 1 });

    // The halves add up to the headline — the split decomposes it, it does not
    // recount it on a different definition.
    const total = metric.byOpener.reduce((sum, o) => sum + o.flows.denominator, 0);
    expect(total).toBe(metric.whatsapp.denominator);
  });

  it('omits an entry point nobody used, rather than reporting it as a failure', async () => {
    await flow(FLOW_OPENER.MENU, 'booked');

    const metric = await report();

    // "free_text: — (no sample)" would read as tried and failed, on a tenant that
    // has no Gemini key configured at all.
    expect(metric.byOpener).toHaveLength(1);
    expect(metric.byOpener[0]?.opener).toBe(FLOW_OPENER.MENU);
  });
});
