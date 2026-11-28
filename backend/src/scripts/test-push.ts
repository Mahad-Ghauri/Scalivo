// Dev-only: send one test push per channel to the seeded owner's devices.
// Run: pnpm tsx --env-file=.env --env-file=.env.local src/scripts/test-push.ts [bookings|health|briefing]
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';

if (!/localhost|127\.0\.0\.1|mongo:/.test(env.MONGO_URI)) throw new Error('Refusing: not a local database');

const messages = {
  bookings: { title: 'Test: new booking', body: 'Ayesha booked a facial at 4pm', channel: PUSH_CHANNEL.BOOKINGS, route: '/appointments' },
  health: { title: 'Test: WhatsApp disconnected', body: 'Tap to relink', channel: PUSH_CHANNEL.SESSION_HEALTH, route: '/qr' },
  briefing: { title: 'Test: morning briefing', body: '5 bookings today', channel: PUSH_CHANNEL.BRIEFING, route: '/briefings' },
};

const pick = process.argv[2] as keyof typeof messages | undefined;
await mongoose.connect(env.MONGO_URI);
const owner = await User.findOne({ email: 'owner@skinare.pk' }).lean();
if (!owner?.businessIds?.[0]) throw new Error('seeded owner not found');
for (const [name, msg] of Object.entries(messages)) {
  if (pick && pick !== name) continue;
  const sent = await pushToOwners(String(owner.businessIds[0]), msg);
  console.log(`${name}: sent to ${sent} device(s)`);
}
await mongoose.disconnect();
