import mongoose from 'mongoose';
import { BOOKING_STATUS } from '@scalivo/shared';
import { env } from '../config/env.js';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { User } from '../models/User.js';
import { hashPassword } from '../auth/routes.js';
import { toBusinessLocal, wallClockToUtc } from '../lib/time.js';

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
 */

const SLUG = 'skinare';
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
    [Business, User, Service, Staff, Client, Booking].map((m) => m.syncIndexes()),
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
      published: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const businessId = String(business._id);

  // Clear only this business's data, so a seeded dev DB with other work survives.
  const previous = await Booking.find({ businessId }).distinct('clientId');
  await Promise.all([
    Booking.deleteMany({ businessId }),
    Service.deleteMany({ businessId }),
    Staff.deleteMany({ businessId }),
    Client.deleteMany({ _id: { $in: previous } }),
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
    { businessId, name: 'Consultation', durationMinutes: 30, priceMinor: 200_000, displayOrder: 1 },
    { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000, displayOrder: 2 },
    { businessId, name: 'Laser session', durationMinutes: 20, priceMinor: 500_000, displayOrder: 3 },
    {
      businessId,
      name: 'Chemical peel',
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
    { businessId, name: 'Dr. Ayesha', serviceIds, workingHours: hours, active: true },
    { businessId, name: 'Dr. Sana', serviceIds, workingHours: hours, active: true },
  ]);

  let phoneCounter = 3001234000;
  let bookingCount = 0;
  let clientCount = 0;

  for (const cohort of COHORTS) {
    for (let i = 0; i < cohort.count; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;

      // Two clients deliberately have no phone: one LID that never resolved,
      // one owner-entered walk-in. Both must coexist under the partial index —
      // this pair is what proves it, and it is why the index cannot be sparse.
      const unmatched = clientCount === 7 || clientCount === 18;
      const client = await Client.create({
        phone: unmatched ? null : `92${phoneCounter++}`,
        lids: unmatched && clientCount === 7 ? [`17740396${phoneCounter}@lid`] : [],
        displayName: name,
      });
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

  console.log(`
  business   Skinare Aesthetics (${businessId})
  owner      ${OWNER_EMAIL} / ${OWNER_PASSWORD}
  services   ${services.length}
  staff      ${staff.length}
  clients    ${clientCount}  (2 with no phone number)
  bookings   ${bookingCount}
  `);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
