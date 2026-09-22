import { isGrowChannel, type FunnelEvent, type GrowChannel } from '@scalivo/shared';
import { API_BASE } from './site';

/**
 * The profile page's side of the Grow funnel (SPEC §10): tell the backend a
 * visitor arrived, or started booking, and where they came from.
 *
 * Browser only. Everything here is best-effort — storage can be blocked, the
 * request can fail — and none of it may ever get in the way of a booking.
 */

const VISITOR_KEY = 'scalivo:visitor';
const channelKey = (slug: string) => `scalivo:channel:${slug}`;

/**
 * A random id this browser keeps, so a reload is not a second visitor.
 * Not a person and not a cookie: it never leaves this site's own origin except
 * inside the beacon, and it identifies nothing but "the same browser as before".
 */
function visitorId(): string {
  try {
    const known = window.localStorage.getItem(VISITOR_KEY);
    if (known) return known;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked (private mode, a strict browser): one id per page load.
    // Reloads then over-count, which only makes conversion look worse.
    return (memoryId ??= crypto.randomUUID());
  }
}
let memoryId: string | undefined;

function fromReferrer(): GrowChannel | null {
  if (!document.referrer) return null;
  try {
    const host = new URL(document.referrer).hostname;
    if (host === window.location.hostname) return 'marketplace';
    if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(host)) return 'facebook';
    if (/(^|\.)(whatsapp\.com|wa\.me)$/.test(host)) return 'whatsapp';
  } catch {
    // An unparseable referrer is no referrer.
  }
  return null;
}

/**
 * Where this visit came from, remembered for the rest of the tab's session so
 * the booking made three steps later is credited to the poster that started it.
 *
 * `?ref=` wins, because the owner put it there on purpose; then what this tab
 * already decided; then the referrer; then "direct".
 */
export function currentChannel(slug: string): GrowChannel {
  const ref = new URLSearchParams(window.location.search).get('ref');
  let channel: GrowChannel | null = isGrowChannel(ref) ? ref : null;

  try {
    channel ??= (() => {
      const stored = window.sessionStorage.getItem(channelKey(slug));
      return isGrowChannel(stored) ? stored : null;
    })();
  } catch {
    // Storage blocked; fall through to the referrer.
  }

  channel ??= fromReferrer() ?? 'direct';

  try {
    window.sessionStorage.setItem(channelKey(slug), channel);
  } catch {
    // Nothing to do — the next call works it out again.
  }
  return channel;
}

/** Fire and forget. text/plain keeps it a simple request, so there is no CORS preflight per page view. */
export function track(slug: string, type: FunnelEvent): void {
  try {
    void fetch(`${API_BASE}/public/businesses/${encodeURIComponent(slug)}/events`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ type, channel: currentChannel(slug), visitorId: visitorId() }),
    }).catch(() => {});
  } catch {
    // Never let counting break the page.
  }
}
