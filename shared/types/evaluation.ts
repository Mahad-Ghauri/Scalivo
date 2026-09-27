/**
 * The evaluation contract — PROJECT_PLAN §7, built in milestone 3.9.
 *
 * Six metrics carry the thesis. This file is their shape, and the shape is doing
 * real work: every one of them is a proportion, and a proportion reported without
 * its denominator is not a finding, it is a number. So nothing here is a bare
 * percentage. Each metric carries what it counted, what it counted out of, and —
 * the part that is easy to leave out and impossible to add later — what it had to
 * EXCLUDE and why.
 *
 * The analysis itself is Phase 5.4. This is the pipeline: the milestone's whole
 * claim is that every figure below can be pulled on demand, so that the pilot's
 * first week is not spent discovering that something was never logged.
 */

/**
 * A proportion, with the two numbers it came from kept in view.
 *
 * `rate` is null — never 0 — when the denominator is zero, and that distinction is
 * the single most load-bearing decision in this file. "No customer stood us up
 * because nobody was booked" and "no customer stood us up out of 200 bookings" are
 * opposite findings, and a 0 that means "nothing to divide" would be read as the
 * second and reported as a triumph. Every consumer has to handle the null, which
 * is the point: it makes an empty sample impossible to print by accident.
 */
export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator ÷ denominator, or null when there was nothing to divide. */
  rate: number | null;
}

export const rateOf = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
});

/**
 * No-show rate, deposit-required against not — SPEC §12.3.
 *
 * The split is on whether a deposit was ASKED FOR, not on whether one was paid.
 * That is deliberate and it is the weaker-looking of the two choices, so it is
 * worth saying why: requiring a deposit is the intervention the business applies,
 * and paying it is the customer's response to it. Splitting on payment would
 * compare people who chose to pay against everyone else, and people who pay
 * deposits turn up anyway — the comparison would measure the customers, not the
 * policy. This is the intention-to-treat split, and it is the honest one.
 *
 * `unpaidWithDeposit` is reported alongside because it is the caveat that makes
 * the first number readable: a deposit-required arm where most deposits went
 * unpaid is measuring a demand for money, not a deposit taken.
 */
export interface NoShowMetric {
  withDeposit: Rate;
  withoutDeposit: Rate;
  /**
   * Percentage points the deposit arm is BELOW the other. Positive means deposits
   * are associated with fewer no-shows. Null when either arm has no sample.
   */
  differencePoints: number | null;
  /** Deposit-required appointments that reached their hour without the deposit paid. */
  unpaidWithDeposit: number;
}

/**
 * Retention conversion — SPEC §6.3.
 *
 * Split by kind because a rebooking nudge and a broadcast are different
 * interventions aimed at different people, and averaging them would hide whichever
 * one works. `replies` is the softer signal and is kept because a campaign that
 * gets answered but not booked is a finding of its own.
 *
 * `notSent` is the excluded set: a nudge still QUEUED behind an outage cannot have
 * caused a booking, so it is in neither the numerator nor the denominator. Left
 * in, an outage would read as a campaign that failed to convert.
 */
export interface RetentionMetric {
  nudges: Rate;
  campaigns: Rate;
  replies: Rate;
  /** Claimed but never handed to the provider — excluded from every rate above. */
  notSent: number;
  /**
   * Sends whose attribution window is still open, counted in the denominator.
   *
   * A nudge has a fortnight to produce a booking, so one sent three days before the
   * report ran has not failed to convert — it has not finished. Reported rather than
   * excluded, because dropping it would quietly change the denominator depending on
   * when someone happened to run this; naming it lets the analysis decide, and
   * explains a conversion rate that looks low on a window ending today.
   */
  unresolved: number;
  /**
   * Sends to people who had never messaged this business (FINDING #3).
   *
   * The honest explanation for a poor delivery rate, and unrecoverable after the
   * fact — which is why it is stamped at claim time on the Notification.
   */
  coldContacts: number;
}

/**
 * Booking completion, WhatsApp against web — PROJECT_PLAN §7.
 *
 * The metric the milestone existed to unblock. Its WhatsApp denominator did not
 * exist before 3.9: conversation state is ephemeral by design and an abandoned
 * flow left no trace, so only the successes were observable. Counting those alone
 * would have produced a completion rate of 100%.
 *
 * The two arms are NOT the same measurement and must not be presented as one
 * number. A WhatsApp flow is a conversation someone chose to start; a web start is
 * a form opening on a page they may have landed on by accident. The comparison is
 * still worth making — it is the one the spec asks for — but the web arm's
 * denominator is the looser of the two.
 */
export interface CompletionMetric {
  whatsapp: Rate;
  /**
   * Web bookings over recorded form starts — and this one CAN exceed 1.
   *
   * Not a bug, and deliberately not clamped. The two halves come from different
   * records: the numerator is a Booking, the denominator a FunnelDay counter, and a
   * booking can exist with no start behind it — one made before the counter existed,
   * one whose counter upsert failed, or a seeded fixture. A rate over 100% is
   * therefore a true statement about data completeness, and capping it at 100% would
   * throw away the only signal that the funnel is under-counting. Anything reading
   * this should show the counts, not just the percentage.
   */
  web: Rate;
  /**
   * Flows neither booked nor abandoned at the moment of asking — still live.
   *
   * In neither the numerator nor the denominator. A flow that started four minutes
   * ago has not failed, and counting it as abandoned would make every report
   * understate completion by however many customers happened to be mid-booking.
   */
  whatsappOpen: number;
  /**
   * Flows the menu itself gave up on, after three consecutive misreads handed the
   * customer to a human.
   *
   * Counted as a failure to complete, and reported on its own line because it is
   * the most damning number in the funnel and the least visible: those customers
   * did not lose interest, the interface defeated them. Folded into "abandoned" it
   * would be indistinguishable from someone who simply put their phone down.
   */
  whatsappEscalated: number;
  /**
   * Flows the customer left deliberately — typed STOP or CANCEL, or asked for a
   * person.
   *
   * Excluded from both arms of the rate. Someone who decides not to book has not
   * been failed by the booking flow, and counting their decision as an incompletion
   * would make the metric worse every time it worked correctly.
   */
  whatsappLeft: number;
  /** Where the flows that did not complete stopped, most first — the usability finding. */
  whatsappDropOff: FlowDropOff[];
  /** Reschedules, reported apart: a flow with an appointment already behind it. */
  whatsappReschedules: Rate;
  /** Messages an average completed flow took, null with no completions. */
  messagesPerBooking: number | null;
  /** Times the menu misread a customer, per flow. The cost of a numbered list. */
  invalidInputsPerFlow: number | null;
  /**
   * The same funnel, split by how the customer entered it — milestone 3.2's evidence.
   *
   * Reported as a list rather than two named fields so an opener with no flows is
   * absent rather than a row of nulls: before free-text parsing is switched on for a
   * tenant, "free_text: — (no sample)" would suggest it was tried and failed.
   *
   * These are observational, not an experiment. Customers were not assigned to an
   * arm; they chose whether to type a sentence, and the ones who do are plausibly
   * the more confident users. A difference here is a finding worth reporting and not
   * a causal claim, and the evaluation chapter has to say so.
   */
  byOpener: OpenerCompletion[];
}

export interface OpenerCompletion {
  /** A FLOW_OPENER value. */
  opener: string;
  /** Completed over attempted, on exactly the same definition as `whatsapp`. */
  flows: Rate;
  messagesPerBooking: number | null;
  invalidInputsPerFlow: number | null;
}

export interface FlowDropOff {
  /**
   * A conversation state, as a plain string.
   *
   * Not a shared union: CONVERSATION_STATE is deliberately backend-only
   * (whatsapp/fsm/states.ts) and publishing it here would invite a client to
   * branch on the FSM's internals. The evaluation reads these; it does not
   * dispatch on them.
   */
  state: string;
  flows: number;
}

/**
 * Session uptime — the thesis's headline metric and its one genuine contribution.
 *
 * Computed by walking SessionEvent's transitions in order and measuring the gaps.
 * Three buckets, not two, and the third is the honest one: `untrackedMs` is time
 * that is neither up nor down — before the first transition ever recorded, and any
 * span where we had deliberately stopped the session or a human was mid-link.
 * Folding that into downtime would report our own maintenance as the platform
 * failing; folding it into uptime would inflate the number the thesis rests on.
 *
 * Per session as well as in total, because a re-link produces a NEW session id and
 * the two histories are not one continuous run. Averaging across a re-link would
 * read the gap where the owner was holding a phone as an outage.
 */
export interface UptimeMetric {
  sessions: SessionUptime[];
  upMs: number;
  downMs: number;
  untrackedMs: number;
  /** upMs ÷ (upMs + downMs) — untracked time is excluded from both. */
  rate: number | null;
  /**
   * Where measurement actually begins, which is not always the `from` asked for.
   *
   * It is `from` when a transition before the window establishes what the session
   * was doing when the window opened, and the first transition inside the window
   * otherwise. Null when nothing is known either way — a business that was never
   * linked, which is not the same as one that was down and must not be reported as
   * 0% uptime.
   */
  measuredFrom: string | null;
  /**
   * The instant the report was run.
   *
   * Uptime is only ever computable against a clock: the newest transition opens an
   * interval that no row closes, and there is no record saying "still up". Writing
   * one on a timer would be manufacturing evidence, so the open interval runs to
   * here and the report says so.
   */
  measuredTo: string;
  outages: number;
  longestOutageMs: number;
}

export interface SessionUptime {
  sessionId: string;
  upMs: number;
  downMs: number;
  untrackedMs: number;
  outages: number;
  longestOutageMs: number;
  /** Still the business's current session — its last interval is open. */
  current: boolean;
}

/**
 * Adoption — bookings per week, and how many the owner still typed in themselves.
 *
 * The automated/manual ratio is the one that answers whether the system is
 * actually being used or merely present. An owner entering every booking by hand
 * has a calendar, not a booking system, and the weekly series is what shows that
 * changing (or not).
 */
export interface AdoptionMetric {
  weeks: AdoptionWeek[];
  total: number;
  /** WhatsApp and web — the customer did it themselves. */
  automated: number;
  /** Owner-entered: a walk-in, a phone call, or the system being bypassed. */
  manual: number;
  automatedShare: Rate;
}

export interface AdoptionWeek {
  /** The Monday, as a business-local 'YYYY-MM-DD'. */
  from: string;
  bookings: number;
  whatsapp: number;
  web: number;
  owner: number;
}

/**
 * Review capture — SPEC §9.
 *
 * Two rates, because one number cannot distinguish the two ways this fails.
 * `requested` is whether we asked at all — a review pass that never ran, or
 * appointments nobody marked complete, and a capture rate computed over a handful
 * of requests looks fine while the feature is dead. `captured` is the rate proper:
 * ratings back over requests made.
 */
export interface ReviewMetric {
  captured: Rate;
  requested: Rate;
  averageRating: number | null;
  /** Counts for 1–5 stars, index 0 being one star. */
  distribution: [number, number, number, number, number];
  /** 4–5 stars, which are the only ones a stranger ever sees. */
  published: number;
}

/**
 * Agent engagement — beyond PROJECT_PLAN §7's six, and the input milestone 3.4
 * needs before it can adapt anything.
 *
 * `read` counts only an explicit gesture: the briefing card marks itself read when
 * the owner presses the button or follows a suggested action, never on render.
 * Counting a render would make "the owner engaged with this" mean "the dashboard
 * loaded", and 3.4 would then tune itself on a signal that is always positive.
 */
export interface AgentEngagementMetric {
  briefings: number;
  read: Rate;
  /** Per kind, so a daily nobody opens is distinguishable from an alert they act on. */
  byKind: AgentKindEngagement[];
  /** Briefings phrased by Gemini rather than the template — the degradation rate. */
  phrasedByLlm: Rate;
}

export interface AgentKindEngagement {
  kind: string;
  read: Rate;
}

/** Everything, for one business, over one window. */
export interface EvaluationReport {
  businessId: string;
  businessName: string;
  timezone: string;
  /** Business-local 'YYYY-MM-DD', inclusive at both ends. */
  from: string;
  to: string;
  generatedAt: string;
  noShow: NoShowMetric;
  retention: RetentionMetric;
  completion: CompletionMetric;
  uptime: UptimeMetric;
  adoption: AdoptionMetric;
  reviews: ReviewMetric;
  agent: AgentEngagementMetric;
}

/**
 * How a booking conversation ended.
 *
 * `abandoned` is never stored. It is what an open flow becomes once it has been
 * silent longer than the conversation TTL, and it is derived at read time against
 * the clock for the same reason uptime's last interval is: there is no moment at
 * which a customer announces they have given up, and a sweeper writing one would
 * be inventing an event. See models/FlowRun.ts.
 */
export const FLOW_OUTCOME = {
  /** Reached a confirmed appointment. */
  BOOKED: 'booked',
  /**
   * Left the booking path on purpose — typed STOP or CANCEL, or asked for a human
   * from a standing start. Not a failure to complete, and not counted as one.
   */
  LEFT: 'left',
  /**
   * Handed to a human by the menu after three consecutive misreads.
   *
   * Distinguished from LEFT because the two look identical in the FSM — both end in
   * the HELP state — and mean opposite things. One is a customer choosing to talk
   * to someone; the other is the interface failing and saying so. Telling them
   * apart is possible only at the moment it happens, from the invalid counter, so
   * it is recorded then rather than inferred later.
   */
  ESCALATED: 'escalated',
} as const;

export type FlowOutcome = (typeof FLOW_OUTCOME)[keyof typeof FLOW_OUTCOME];

/** What opened the flow. A reschedule is a booking flow with an appointment behind it. */
export const FLOW_KIND = {
  NEW: 'new',
  RESCHEDULE: 'reschedule',
} as const;

export type FlowKind = (typeof FLOW_KIND)[keyof typeof FLOW_KIND];

/**
 * How the customer got into the flow — the numbered menu, or a sentence.
 *
 * Recorded because milestone 3.2 is a claim that needs testing rather than a
 * feature that obviously works: free-text booking is supposed to cost the customer
 * fewer messages than the menu, and the honest way to find out is to measure both
 * against the same funnel. The menu's baseline was already accumulating before
 * parsing existed, so the comparison is available from the first parsed flow.
 *
 * It has to be stored rather than derived. `startedState` nearly distinguishes them
 * — a menu flow always opens at the service list — but not quite: a free-text parse
 * that resolves only the service opens at date selection, and so does accepting the
 * rebook offer after a cancellation. Two different things landing on one state is
 * exactly the ambiguity that makes a metric quietly wrong.
 */
export const FLOW_OPENER = {
  MENU: 'menu',
  FREE_TEXT: 'free_text',
} as const;

export type FlowOpener = (typeof FLOW_OPENER)[keyof typeof FLOW_OPENER];
