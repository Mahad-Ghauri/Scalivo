import mongoose from 'mongoose';
import { SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';
import { env } from '../config/env.js';
import { Business } from '../models/Business.js';

/**
 * ADOPTS an OpenWA session that already exists.
 *
 * Onboarding creates sessions now (POST /businesses/:id/whatsapp/session), so
 * this is no longer the normal path — but it is still the only way to point a
 * business at a session the gateway already has and we did not create: the
 * spike's own session, or one left behind by a reinstall. Provisioning would
 * build a second Chromium profile beside it; this just claims the first.
 *
 * It deliberately does NOT register a webhook. A session created outside the
 * app has whatever webhook it was given, and silently repointing one that
 * another process is depending on is worse than making you do it explicitly.
 *
 * Usage:
 *   pnpm --filter @scalivo/backend link-session <slug> <sessionId>
 *
 * The session id is the UUID OpenWA assigned, not the name you gave it — the
 * spike stores it in `open-wa/.session-<name>`.
 */

const [slug, sessionId] = process.argv.slice(2);

function die(msg: string): never {
  console.error(`error: ${msg}`);
  console.error('usage: link-session <business-slug> <openwa-session-uuid>');
  process.exit(1);
}

if (!slug || !sessionId) die('both a business slug and a session id are required');

async function main() {
  await mongoose.connect(env.MONGO_URI);

  const business = await Business.findOne({ slug });
  if (!business) die(`no business with slug '${slug}'`);

  // A session id belongs to exactly one business. Two businesses sharing one
  // would cross-route every inbound message, and the webhook keys on sessionId
  // to decide whose booking it is — so this is a correctness check, not tidiness.
  const taken = await Business.findOne({
    'whatsapp.sessionId': sessionId,
    _id: { $ne: business._id },
  });
  if (taken) die(`session already linked to '${taken.slug}'`);

  const previous = business.whatsapp?.sessionId;
  if (previous && previous !== sessionId) {
    console.warn(`warning: replacing existing session ${previous}`);
  }

  // Status is left at CREATED deliberately. The gateway is the authority and
  // the webhook stream will correct it within seconds; writing 'ready' here
  // would be us asserting a liveness we have not observed.
  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        'whatsapp.sessionId': sessionId,
        'whatsapp.intent': SESSION_INTENT.LIVE,
        'whatsapp.status': SESSION_STATUS.CREATED,
        'whatsapp.lastStatusChange': new Date(),
      },
    },
  );

  console.log(`linked ${slug} -> ${sessionId}`);
  console.log('intent=live, status=created (the gateway will correct status)');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
