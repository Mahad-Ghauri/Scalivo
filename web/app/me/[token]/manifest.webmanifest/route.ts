import type { NextRequest } from 'next/server';

/**
 * The web app manifest, generated per customer — milestone 3.3.
 *
 * It has to be per customer because of one field: `start_url`. An installed
 * icon opens `start_url`, and the only address that shows somebody their
 * appointments is the one carrying their token. A single static manifest at the
 * site root would install an icon that opens a 404 — which is the whole feature
 * failing at the one moment it is supposed to pay off.
 *
 * That also means the manifest carries a credential, so it is served
 * `no-store`, never indexed, and fetched same-origin (the `<link>` on the page
 * has no `crossorigin`, and `use-credentials` is unnecessary since the token is
 * in the path rather than a cookie).
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const start = `/me/${encodeURIComponent(token)}`;

  const manifest = {
    name: 'My appointments',
    /**
     * The home-screen label, and it is read over shoulders — so it names no
     * business and no person. "Appointments" tells the owner what it is and
     * tells a stranger nothing.
     */
    short_name: 'Appointments',
    description: 'Your upcoming appointments, points and one-tap rebooking.',
    start_url: start,
    /**
     * Scope is this one page, matching the service worker's. A wider scope
     * would pull the marketplace into the installed window, where a customer
     * who tapped through to a business profile would be stuck in a chromeless
     * browser with no address bar and no way back.
     */
    scope: '/me/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    /** Brand purple: the status bar and splash screen wear this. */
    theme_color: '#6950f3',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Full-bleed, for launchers that mask the icon to their own shape.
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    },
  });
}
