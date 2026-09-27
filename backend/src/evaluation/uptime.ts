import {
  SESSION_INTENT,
  SESSION_STATUS,
  type SessionUptime,
  type UptimeMetric,
} from '@scalivo/shared';
import { SessionEvent } from '../models/SessionEvent.js';

/**
 * Session uptime — PROJECT_PLAN §7's headline metric.
 *
 * The thesis's one genuine contribution is a measured answer to "can an
 * unofficial WhatsApp integration stay up?", so this is the number the whole
 * evaluation rests on and the easiest one to compute flatteringly by accident.
 * Three decisions keep it honest, and each of them lowers the figure:
 *
 * 1. **Time we caused is neither up nor down.** A session deliberately stopped, or
 *    one where a human is mid-link, is UNTRACKED and leaves both the numerator and
 *    the denominator. Counting it as uptime would let a long maintenance window
 *    improve the score; counting it as downtime would blame the platform for our
 *    own deploys.
 * 2. **Time before anything was recorded is untracked too.** A business that has
 *    never linked has no uptime, which is different from 0%.
 * 3. **The last interval is open and runs to the clock.** No row ever says "still
 *    up", and writing one on a timer would be manufacturing evidence. So the report
 *    states the instant it stopped measuring.
 *
 * ## The intervals
 *
 * SessionEvent is append-only and holds only TRANSITIONS, so consecutive rows are
 * the interval boundaries: the state that row describes holds until the next row.
 * Which means the row that establishes the state at the START of the window is
 * usually OUTSIDE it — a business that was up all March with no incidents has no
 * March rows at all. Reading only the window would report that business as having
 * no uptime, so the last transition before `from` is fetched to seed the walk. That
 * single query is the difference between measuring a quiet month and missing it.
 */

/** A session is only up when it is ready AND we believed it should be. */
function classify(status: string, intent: string): 'up' | 'down' | 'untracked' {
  if (intent !== SESSION_INTENT.LIVE) return 'untracked';
  return status === SESSION_STATUS.READY ? 'up' : 'down';
}

interface Tally {
  upMs: number;
  downMs: number;
  untrackedMs: number;
  outages: number;
  longestOutageMs: number;
  lastSessionId: string | null;
}

const empty = (): Tally => ({
  upMs: 0,
  downMs: 0,
  untrackedMs: 0,
  outages: 0,
  longestOutageMs: 0,
  lastSessionId: null,
});

export async function sessionUptime(
  businessId: string,
  from: Date,
  to: Date,
  now = new Date(),
): Promise<UptimeMetric> {
  // Never measure the future: a window ending next week would otherwise add days
  // of "still up" that have not happened yet.
  const measuredTo = to.getTime() > now.getTime() ? now : to;

  const [seed, events] = await Promise.all([
    // The state as the window opened. Sorted descending and limited to one — this
    // is the row that makes a quiet month measurable.
    SessionEvent.findOne({ businessId, occurredAt: { $lt: from } }).sort({ occurredAt: -1 }),
    SessionEvent.find({
      businessId,
      occurredAt: { $gte: from, $lte: measuredTo },
    }).sort({ occurredAt: 1 }),
  ]);

  const perSession = new Map<string, Tally>();
  const total = empty();

  /** Attribute one interval to its session and to the total. */
  const add = (sessionId: string, kind: 'up' | 'down' | 'untracked', ms: number): void => {
    if (ms <= 0) return;

    const session = perSession.get(sessionId) ?? empty();

    if (kind === 'up') {
      session.upMs += ms;
      total.upMs += ms;
    } else if (kind === 'down') {
      session.downMs += ms;
      total.downMs += ms;
      // One outage per contiguous down interval, so a session that drops once and
      // stays down for a day is one incident and not 288 of them.
      session.outages += 1;
      total.outages += 1;
      session.longestOutageMs = Math.max(session.longestOutageMs, ms);
      total.longestOutageMs = Math.max(total.longestOutageMs, ms);
    } else {
      session.untrackedMs += ms;
      total.untrackedMs += ms;
    }

    perSession.set(sessionId, session);
  };

  // The walk. Each boundary closes the interval the previous one opened.
  let openedAt: Date | null = null;
  let openState: { sessionId: string; kind: 'up' | 'down' | 'untracked' } | null = null;

  if (seed) {
    openedAt = from;
    openState = {
      sessionId: seed.sessionId,
      kind: classify(seed.status, seed.intent),
    };
  }

  for (const event of events) {
    if (openedAt && openState) {
      add(openState.sessionId, openState.kind, event.occurredAt.getTime() - openedAt.getTime());
    }

    openedAt = event.occurredAt;
    openState = {
      sessionId: event.sessionId,
      kind: classify(event.status, event.intent),
    };
  }

  // The open interval, closed against the clock rather than against a row.
  if (openedAt && openState) {
    add(openState.sessionId, openState.kind, measuredTo.getTime() - openedAt.getTime());
  }

  const measuredFrom = seed ? from : (events[0]?.occurredAt ?? null);

  const sessions: SessionUptime[] = [...perSession.entries()].map(([sessionId, tally]) => ({
    sessionId,
    upMs: tally.upMs,
    downMs: tally.downMs,
    untrackedMs: tally.untrackedMs,
    outages: tally.outages,
    longestOutageMs: tally.longestOutageMs,
    // The session holding the open interval is the one still running.
    current: sessionId === (openState?.sessionId ?? null),
  }));

  const measured = total.upMs + total.downMs;

  return {
    sessions,
    upMs: total.upMs,
    downMs: total.downMs,
    untrackedMs: total.untrackedMs,
    // Untracked time is in neither half of this fraction, which is what makes it
    // "of the time we were meant to be up" rather than "of the calendar".
    rate: measured === 0 ? null : total.upMs / measured,
    measuredFrom: measuredFrom instanceof Date ? measuredFrom.toISOString() : null,
    measuredTo: measuredTo.toISOString(),
    outages: total.outages,
    longestOutageMs: total.longestOutageMs,
  };
}
