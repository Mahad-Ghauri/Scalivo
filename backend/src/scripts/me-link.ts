import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Business } from '../models/Business.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { meTokenFor } from '../me/token.js';

/**
 * Prints the `/me/<token>` URL for a seeded customer.
 *
 * In production nobody ever runs this: the link reaches a customer inside their
 * booking confirmation, and that is the only way it is ever handed out
 * (notifications/confirm.ts). But the confirmation goes out over WhatsApp, so
 * checking the customer page normally requires a working session — which makes
 * the one screen built for customers unreachable whenever the gateway is down,
 * including right now.
 *
 * So this mints the token by the same call the confirmation uses and prints the
 * URL. It is not a back door: it only addresses a profile that already exists,
 * and the token it mints is the one that customer would have been sent anyway.
 *
 * Usage, FROM the backend directory — the --env-file paths are relative to the
 * working directory, and `pnpm --filter` does not change it:
 *
 *   cd backend
 *   pnpm exec tsx --env-file=.env --env-file=.env.local src/scripts/me-link.ts [slug]
 *
 * Point it at the LOCAL database. Run against a real tenant it would mint a real
 * customer's token and print it to a terminal, which is exactly the thing
 * me/token.ts promises not to do.
 */

const slug = process.argv[2];

async function main() {
  await mongoose.connect(env.MONGO_URI);

  // A profile is keyed by businessId, so a slug has to be resolved first.
  let filter: Record<string, string> = {};
  if (slug) {
    const business = await Business.findOne({ slug }).lean();
    if (!business) {
      console.error(`no business with slug '${slug}'`);
      process.exit(1);
    }
    filter = { businessId: String(business._id) };
  }

  // The busiest profile, because it is the one with something to look at: past
  // visits, a usual service, and the best chance of an appointment to rate.
  const profile = await ClientProfile.findOne(filter).sort({ totalVisits: -1 }).lean();

  if (!profile) {
    console.error('no client profiles found — run `pnpm --filter @scalivo/backend seed:local` first');
    process.exit(1);
  }

  const token = await meTokenFor(String(profile.businessId), String(profile.clientId));

  console.log(`\n  ${env.WEB_URL}/me/${token}`);
  console.log(`  visits ${profile.totalVisits ?? 0}   business ${String(profile.businessId)}\n`);

  await mongoose.disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
