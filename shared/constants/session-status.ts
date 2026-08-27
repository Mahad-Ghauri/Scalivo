/**
 * OpenWA session lifecycle.
 *
 * These are the exact values OpenWA v0.14.6 emits in `session.status.data.status`,
 * confirmed against 9 observed `session.status` deliveries in the spike
 * (open-wa/findings/webhooks.ndjson).
 */
export const SESSION_STATUS = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  QR_READY: 'qr_ready',
  AUTHENTICATING: 'authenticating',
  READY: 'ready',
  DISCONNECTED: 'disconnected',
  ACTION_REQUIRED: 'action_required',
  FAILED: 'failed',
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

/**
 * What *we* believe should be happening with a session. Session Health compares
 * the observed status against this — without it, a `qr_ready` we caused (by
 * linking a new business) is indistinguishable from one WhatsApp sent us because
 * the session died.
 */
export const SESSION_INTENT = {
  /** We asked for a QR. A qr_ready here is expected, not an alarm. */
  LINKING: 'linking',
  /** Linked and expected to stay up. A qr_ready here is the alarm. */
  LIVE: 'live',
  /** Deliberately stopped by us. Nothing here is an alarm. */
  STOPPED: 'stopped',
} as const;

export type SessionIntent = (typeof SESSION_INTENT)[keyof typeof SESSION_INTENT];

/**
 * The single most important function in Session Health.
 *
 * SPIKE FINDING #2: a phone-side unlink does NOT emit `disconnected`, and
 * `session.disconnected` never fired once across the entire spike. The observed
 * sequence was:
 *
 *     17:29:32.899  session.qr      { qr: "data:image/png;base64,..." }
 *     17:29:32.903  session.status  { status: "qr_ready" }
 *
 * ...and that is the complete event set. A monitor watching for
 * `status === 'disconnected'` sits silent through a session that is dead and
 * needs a human with a phone.
 *
 * So the real alarm is an *unsolicited* qr_ready — one arriving while we believe
 * the session is LIVE. `disconnected` is still handled because it presumably
 * covers network-level drops, which the spike did not test.
 *
 * Corollary: after an unlink the session still reports its original `phone`,
 * its original `connectedAt`, and `lastError: null`. None of them is a liveness
 * signal — don't reach for `session.phone != null`.
 */
export function isSessionAlarm(status: SessionStatus, intent: SessionIntent): boolean {
  if (intent !== SESSION_INTENT.LIVE) return false;

  return (
    status === SESSION_STATUS.QR_READY ||
    status === SESSION_STATUS.DISCONNECTED ||
    status === SESSION_STATUS.ACTION_REQUIRED ||
    status === SESSION_STATUS.FAILED
  );
}
