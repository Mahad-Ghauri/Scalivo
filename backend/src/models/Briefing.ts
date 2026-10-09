import { Schema, model } from 'mongoose';
import { ALERT_TYPE, BRIEFING_KIND, PHRASED_BY } from '@scalivo/shared';

/**
 * One thing the agent told an owner — SPEC §11.
 *
 * A record rather than fire-and-forget push, for three reasons that each turned
 * out to be load-bearing:
 *
 * 1. **The claim is what stops duplicates.** Same discipline as the reminders and
 *    the nudges: `dedupeKey` is unique, so a pass that runs twice, or one that
 *    catches up after an outage, cannot brief the same morning twice. Checking
 *    "did we already send this?" and then sending it is the bug this avoids.
 * 2. **A push that nobody saw is gone.** Notifications are swiped away, phones
 *    are reinstalled, tokens rotate silently. The owner who opens the dashboard
 *    on Tuesday should still be able to read Monday's summary.
 * 3. **The evaluation needs the facts as they were.** `facts` is stored beside
 *    the prose deliberately: it is the only way to check afterwards that what the
 *    agent said matched what it knew, and the only way to recompute a metric when
 *    the phrasing changes. Regenerating it later is not possible — the numbers
 *    describe a morning that has passed.
 *
 * `readAt` is the Learning Layer's (3.4) entire input, which is why it is here
 * now rather than added later: engagement is a fact about a moment, and a
 * subsystem that starts recording it next term has no history to learn from.
 */
const briefingSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },

    kind: { type: String, enum: Object.values(BRIEFING_KIND), required: true },

    /** Only set on alerts. Null elsewhere rather than absent, so queries can filter it. */
    alertType: { type: String, enum: [...Object.values(ALERT_TYPE), null], default: null },

    /**
     * One briefing per business per occasion.
     *
     * Shaped like the other claim keys in the system: `daily:2026-09-26`,
     * `weekly:2026-W39`, `alert:empty_day:2026-10-03`. The date is BUSINESS-LOCAL,
     * which is the point — a UTC day boundary would let a Karachi business be
     * briefed twice for one morning and not at all for another.
     */
    dedupeKey: { type: String, required: true },

    /** When it was due. The pass may write it later; this is the moment it is about. */
    scheduledFor: { type: Date, required: true },

    headline: { type: String, required: true },
    body: { type: String, required: true },

    /**
     * The computed numbers, as a discriminated union on `kind` (shared/types/agent.ts).
     *
     * Mixed because the three shapes have nothing in common and a schema union
     * here would be a third copy of the same types — one in TypeScript, one in
     * Mongoose, and the disagreement between them found in production. The
     * writer is the only thing that produces these and it is typed.
     */
    facts: { type: Schema.Types.Mixed, required: true },

    /** 'template' is a normal outcome, not a failure — see agent/phrase.ts. */
    phrasedBy: { type: String, enum: Object.values(PHRASED_BY), required: true },

    actions: {
      type: [
        {
          label: { type: String, required: true },
          href: { type: String, required: true },
          _id: false,
        },
      ],
      default: [],
    },

    /** How many owner devices the push reached. 0 is meaningful: nobody was told. */
    pushedTo: { type: Number, default: 0 },

    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The claim. Per business, so two tenants' Mondays never collide. */
briefingSchema.index({ businessId: 1, dedupeKey: 1 }, { unique: true });

/** The feed: newest first, for one business. */
briefingSchema.index({ businessId: 1, scheduledFor: -1, _id: -1 });
briefingSchema.index({ businessId: 1, readAt: 1 });

export const Briefing = model('Briefing', briefingSchema);
