import mongoose from 'mongoose';
import { BOOKING_STATUS } from '@scalivo/shared';
import { env } from '../config/env.js';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { recomputeProfile } from '../crm/profile.js';
import { BlockedTime } from '../models/BlockedTime.js';
import { User } from '../models/User.js';
import { Review } from '../models/Review.js';
import { hashPassword } from '../auth/routes.js';
import { seedPhone } from '../messaging/test-numbers.js';
import { occupiedSlots, toBusinessLocal, wallClockToUtc } from '../lib/time.js';

/**
 * Seeds a Skinare-like clinic with enough history that the CRM and retention
 * logic have something real to compute against.
 *
 * The point is the SPREAD, not the volume: clients who should tag New, VIP,
 * At-Risk and Lapsed, a realistic no-show rate, and two clients with no phone
 * number at all — because a LID that never resolved is a case the code must
 * survive, and seeding only tidy data hides it until a pilot finds it.
 *
 * Re-runnable: it clears this business's own data first, and nothing else.
 *
 * **This is synthetic demo data, and it is the ONLY tenant this script writes.**
 * The Uxelerate tenant is deliberately not seeded: it is onboarded through the
 * real Phase 1.5 flow, because exercising that flow — and finding out whether an
 * owner can actually complete it — is the whole reason it exists. A seeded
 * shortcut past onboarding would skip the thing being tested.
 *
 * That matters more than it used to. A real tenant now lives in the same
 * database as this fixture, so "clears this business's own data" has to be true
 * precisely rather than approximately. See the client cleanup below.
 */

const SLUG = 'skinare';

/** Unsplash (free commercial licence), cropped at the CDN so phones never get a 5,000px original. */
const photo = (id: string, size = 'w=900&h=700') =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&q=70&${size}`;
const OWNER_EMAIL = 'owner@skinare.pk';
const OWNER_PASSWORD = 'skinare-dev-password';
const TZ = 'Asia/Karachi';

/** Deterministic PRNG — the same seed gives the same clinic every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20260901);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * Put an appointment at a local wall-clock hour on the given day.
 *
 * Going through the timezone rather than setUTCHours matters: seeded 4pm has to
 * mean 4pm in Karachi, or every "business local day" query reads back wrong and
 * the seed quietly teaches the CRM the wrong thing.
 */
const at = (day: Date, hour: number, timezone: string): Date =>
  wallClockToUtc(
    `${toBusinessLocal(day, timezone).toISODate()}T${String(hour).padStart(2, '0')}:00`,
    timezone,
  );

const FIRST = [
  'Sana', 'Ayesha', 'Hina', 'Mahnoor', 'Zainab', 'Fatima', 'Areeba', 'Noor',
  'Iqra', 'Rabia', 'Amna', 'Laiba', 'Maryam', 'Eman', 'Kiran',
];
const LAST = ['Khan', 'Malik', 'Butt', 'Chaudhry', 'Sheikh', 'Qureshi', 'Awan', 'Bhatti'];

/** The four shapes the tagging rules and retention engine need to see. */
const COHORTS = [
  { tag: 'new', count: 6, visits: [1, 1], lastVisitDaysAgo: [3, 20] },
  { tag: 'regular', count: 10, visits: [3, 6], lastVisitDaysAgo: [5, 25] },
  { tag: 'vip', count: 5, visits: [9, 16], lastVisitDaysAgo: [2, 14] },
  { tag: 'at-risk', count: 5, visits: [3, 7], lastVisitDaysAgo: [55, 80] },
  { tag: 'lapsed', count: 4, visits: [2, 5], lastVisitDaysAgo: [150, 300] },
] as const;

async function seed() {
  // Deleting is destructive, so refuse anything that isn't obviously a dev box.
  const local = /localhost|127\.0\.0\.1|mongo:/.test(env.MONGO_URI);
  if (!local && !process.argv.includes('--force')) {
    throw new Error(
      `Refusing to seed a non-local database (${env.MONGO_URI.replace(/\/\/.*@/, '//***@')}). ` +
        `Pass --force if you really mean it.`,
    );
  }

  await mongoose.connect(env.MONGO_URI);
  console.log('connected');

  // `createIndex` is a no-op when an index of the same name already exists, even
  // if its options have since changed — so a schema edit would silently leave the
  // old definition in place. syncIndexes drops what no longer matches and
  // rebuilds it. Cheap here, and it keeps a dev DB honest about the schema.
  await Promise.all(
    [Business, User, Service, Staff, Client, Booking, SlotOccupancy, BlockedTime, ClientProfile, Review].map(
      (m) => m.syncIndexes(),
    ),
  );
  console.log('indexes synced');

  const business = await Business.findOneAndUpdate(
    { slug: SLUG },
    {
      slug: SLUG,
      name: 'Skinare Aesthetics',
      category: 'clinic',
      timezone: TZ,
      slotIncrementMinutes: 15,
      city: 'Multan',
      published: true,
      // What the marketplace profile shows. Mirrors web/lib/mock-businesses.ts,
      // so the site looks the same whichever source it reads.
      profile: {
        tagline: 'Medical-grade skin, without the hard sell.',
        about:
          'A two-clinician aesthetic practice on Gulgasht Colony, running since 2019. Every appointment opens with a skin read and an honest answer about what will and will not work. Hydrafacials, laser and peels are performed by the physician who consulted you, never handed down.',
        neighbourhood: 'Gulgasht Colony',
        addressLine: '14-B Gulgasht Colony, Multan',
        coverUrl: photo('1552693673-1bf958298935', 'w=1200&h=800'),
        themeColor: '#0F766E',
        gallery: [
          { url: photo('1570172619644-dfd03ed5d881'), alt: 'A client lying back with a facial mask being applied' },
          { url: photo('1616394584738-fc6e612e71b9'), alt: 'A client on a treatment bed with cream applied to her face' },
          { url: photo('1633681926019-03bd9325ec20'), alt: 'A calm waiting area with a sofa and a vase of flowers' },
        ],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const businessId = String(business._id);

  // Clear only this business's data, so a seeded dev DB with other work survives.
  //
  // `Client` is the dangerous one: it is GLOBAL, carrying no businessId, so a
  // person can legitimately be a customer of this fixture AND of a real tenant
  // in the same database. Deleting everyone with a Skinare booking would take
  // that person's row with it and orphan their profile at the real business —
  // silently, because nothing joins back to say it happened.
  //
  // So: delete only clients whose ONLY bookings are Skinare's. Anyone shared
  // with another tenant keeps their row and simply loses their seeded history.
  const previous = await Booking.find({ businessId }).distinct('clientId');
  const sharedWithOthers = await Booking.distinct('clientId', {
    businessId: { $ne: businessId },
    clientId: { $in: previous },
  });
  const shared = new Set(sharedWithOthers.map(String));
  const seedOnly = previous.filter((id) => !shared.has(String(id)));

  if (shared.size > 0) {
    console.log(`keeping ${shared.size} client(s) that another business also books`);
  }

  await Promise.all([
    Booking.deleteMany({ businessId }),
    SlotOccupancy.deleteMany({ businessId }),
    BlockedTime.deleteMany({ businessId }),
    Service.deleteMany({ businessId }),
    Staff.deleteMany({ businessId }),
    Client.deleteMany({ _id: { $in: seedOnly } }),
    ClientProfile.deleteMany({ businessId }),
    Review.deleteMany({ businessId }),
  ]);

  await User.findOneAndUpdate(
    { email: OWNER_EMAIL },
    {
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(OWNER_PASSWORD),
      name: 'Skinare Owner',
      role: 'owner',
      businessIds: [businessId],
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const services = await Service.insertMany([
    {
      businessId,
      name: 'Consultation',
      description: 'A skin read, a plan, and a straight answer on what it will cost.',
      durationMinutes: 30,
      priceMinor: 200_000,
      displayOrder: 1,
    },
    {
      businessId,
      name: 'Hydrafacial',
      description: 'Cleanse, extract and hydrate in one pass. No downtime.',
      durationMinutes: 45,
      priceMinor: 800_000,
      displayOrder: 2,
    },
    {
      businessId,
      name: 'Laser session',
      description: 'Single-area diode session. Course of six recommended.',
      durationMinutes: 20,
      priceMinor: 500_000,
      displayOrder: 3,
    },
    {
      businessId,
      name: 'Chemical peel',
      description: 'Medium-depth peel with a patch test the week before.',
      durationMinutes: 40,
      priceMinor: 650_000,
      // Exercises the deposit path in Phase 2 without needing a config change.
      depositRequired: true,
      depositAmountMinor: 200_000,
      displayOrder: 4,
    },
  ]);
  const serviceIds = services.map((s) => String(s._id));

  // Mon–Sat, 09:00–18:00 local, with a lunch break the availability logic must
  // subtract — a service that would straddle it should not be offered.
  const hours = [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    opensAt: '09:00',
    closesAt: '18:00',
    breaks: [{ startsAt: '13:00', endsAt: '14:00' }],
  }));

  const staff = await Staff.insertMany([
    {
      businessId,
      name: 'Dr. Ayesha',
      role: 'Aesthetic physician',
      avatarUrl: photo('1630939687530-241d630735df', 'w=240&h=240'),
      serviceIds,
      workingHours: hours,
      active: true,
    },
    {
      businessId,
      name: 'Dr. Sana',
      role: 'Aesthetic physician',
      avatarUrl: photo('1595085610896-fb31cfd5d4b7', 'w=240&h=240'),
      serviceIds,
      workingHours: hours,
      active: true,
    },
  ]);

  // Reserved test range (see messaging/test-numbers.ts): never a real person.
  let phoneCounter = 1000;
  let bookingCount = 0;
  let clientCount = 0;

  for (const cohort of COHORTS) {
    for (let i = 0; i < cohort.count; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;

      // Two clients deliberately have no phone: one LID that never resolved,
      // one owner-entered walk-in. Both must coexist under the partial index —
      // this pair is what proves it, and it is why the index cannot be sparse.
      const unmatched = clientCount === 7 || clientCount === 18;
      const phone = unmatched ? null : seedPhone(phoneCounter++);
      const lids = unmatched && clientCount === 7 ? [`17740396${phoneCounter}@lid`] : [];

      /**
       * Upsert by phone, not insert.
       *
       * The cleanup above deliberately KEEPS any client another business also
       * books — and a kept client still holds their phone number. This sequence
       * is deterministic by design ("the same seed gives the same clinic every
       * run"), so the very next run reproduces that number and a plain insert
       * dies on the unique index partway through, leaving a half-seeded
       * database. Reusing the row is also simply correct: same number, same
       * person.
       *
       * $setOnInsert rather than $set, so a real tenant's WhatsApp display name
       * is never overwritten by a fixture's invented one.
       */
      const client = phone
        ? await Client.findOneAndUpdate(
            { phone },
            { $setOnInsert: { phone, lids, displayName: name } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          )
        : await Client.create({ phone: null, lids, displayName: name });
      clientCount++;

      const visits = Math.floor(
        cohort.visits[0] + random() * (cohort.visits[1] - cohort.visits[0] + 1),
      );
      const lastGap =
        cohort.lastVisitDaysAgo[0] +
        random() * (cohort.lastVisitDaysAgo[1] - cohort.lastVisitDaysAgo[0]);
      const spacing = 21 + random() * 25;

      for (let v = 0; v < visits; v++) {
        const service = pick(services);
        const when = daysAgo(lastGap + v * spacing);

        // ~12% no-show, ~6% cancelled — a realistic baseline for the deposit
        // comparison in Phase 2 to be measured against.
        const roll = random();
        const status =
          roll < 0.12
            ? BOOKING_STATUS.NO_SHOW
            : roll < 0.18
              ? BOOKING_STATUS.CANCELLED
              : BOOKING_STATUS.COMPLETED;

        await Booking.create({
          businessId,
          staffId: String(pick(staff)._id),
          clientId: String(client._id),
          serviceId: String(service._id),
          startsAt: at(when, 9 + Math.floor(random() * 8), TZ),
          durationMinutes: service.durationMinutes,
          status,
          priceMinor: service.priceMinor,
          source: random() < 0.7 ? 'whatsapp' : 'owner',
        });
        bookingCount++;
      }

      // A third of the healthy cohorts already have their next appointment —
      // the retention engine must not nudge these people.
      if (cohort.tag !== 'lapsed' && random() < 0.33) {
        const service = pick(services);
        await Booking.create({
          businessId,
          staffId: String(pick(staff)._id),
          clientId: String(client._id),
          serviceId: String(service._id),
          startsAt: at(daysAhead(1 + random() * 12), 10 + Math.floor(random() * 6), TZ),
          durationMinutes: service.durationMinutes,
          status: BOOKING_STATUS.CONFIRMED,
          priceMinor: service.priceMinor,
          source: 'whatsapp',
        });
        bookingCount++;
      }
    }
  }

  // Published reviews for the marketplace profile. Fixtures, like everything
  // here — 2.2 is what writes real ones, from a rating request after a visit.
  await Review.insertMany([
    {
      businessId,
      authorName: 'Hira A.',
      rating: 5,
      comment:
        'Booked on WhatsApp at eleven at night and had a slot confirmed before I put the phone down. Dr. Ayesha talked me out of the package I came in asking for. Skin is better and I spent less.',
      serviceName: 'Hydrafacial',
      published: true,
    },
    {
      businessId,
      authorName: 'Mahnoor S.',
      rating: 5,
      comment: 'Six laser sessions, every one of them started within five minutes of the time on the message.',
      serviceName: 'Laser session',
      published: true,
    },
    {
      businessId,
      authorName: 'Rabia K.',
      rating: 4,
      comment: 'The peel needed a patch test first, which meant two visits instead of one. Annoying, but they were right to insist.',
      serviceName: 'Chemical peel',
      published: true,
    },
  ]);

  // Future bookings need occupancy rows or availability will cheerfully offer
  // times that are already taken — the seeded calendar and the seeded grid have
  // to agree, or every manual test of Phase 1.3 is testing a lie.
  //
  // Past bookings are skipped: they cannot be double-booked, and the random
  // hours above would collide on the unique index. `ordered: false` covers the
  // collisions that remain among future ones — a seed dropping a row is fine,
  // a seed that dies halfway is not.
  const upcoming = await Booking.find({
    businessId,
    startsAt: { $gt: new Date() },
    status: { $ne: BOOKING_STATUS.CANCELLED },
  });

  const occupancy = upcoming.flatMap((booking) =>
    occupiedSlots(booking.startsAt, booking.durationMinutes, business.slotIncrementMinutes).map(
      (slotStart) => ({
        businessId,
        staffId: booking.staffId,
        slotStart,
        bookingId: String(booking._id),
      }),
    ),
  );

  let occupancyRows = 0;
  try {
    const written = await SlotOccupancy.insertMany(occupancy, { ordered: false });
    occupancyRows = written.length;
  } catch (err) {
    occupancyRows = (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;
  }

  // Built by REPLAY rather than written directly. The seeded bookings are the
  // source of truth, and recompute is the same function the CRM repairs drift
  // with — so a seeded profile is provably what a real one would be, and a bug
  // in the derivation shows up in `pnpm seed` rather than after a pilot.
  const seededClients = await Booking.distinct('clientId', { businessId });
  for (const id of seededClients) await recomputeProfile(businessId, id);

  console.log(`
  business   Skinare Aesthetics (${businessId})
  owner      ${OWNER_EMAIL} / ${OWNER_PASSWORD}
  services   ${services.length}
  staff      ${staff.length}
  clients    ${clientCount}  (2 with no phone number)
  bookings   ${bookingCount}  (${upcoming.length} upcoming)
  profiles   ${seededClients.length}  (rebuilt from the bookings)
  occupancy  ${occupancyRows} grid rows
  `);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
