'use client';

import { useEffect } from 'react';
import { track } from '@/lib/funnel';

/**
 * Counts a profile view. A beacon from the browser rather than a count on the
 * server, because the profile page is statically rendered and cached — the
 * server does not see most visits at all.
 */
export function FunnelBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    track(slug, 'view');
  }, [slug]);
  return null;
}
