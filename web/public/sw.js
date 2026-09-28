/**
 * The service worker for the customer's appointments page — milestone 3.3.
 *
 * It exists for one reason: a page is only installable to a home screen if it
 * has a manifest AND a service worker with a fetch handler. Everything below is
 * the smallest honest thing that satisfies that.
 *
 * **Scope is `/me/`, not `/`.** It is registered with an explicit narrower
 * scope (see InstallHint.tsx), which a worker served from the root is allowed to
 * claim. A root-scoped worker would sit in front of the marketplace and the
 * owner's dashboard too — pages that have nothing to do with this feature and
 * would then inherit its caching rules and its bugs.
 *
 * **It does not cache appointments.** Tempting, and wrong twice over. A cached
 * page would show a time that has since been rescheduled, and somebody turning
 * up an hour late because their phone showed them yesterday's answer is a worse
 * failure than not opening at all. And the HTML carries one person's visit
 * history and spend, which then sits in Cache Storage on a device that may be
 * shared. So: the network is the only source of appointments, and offline says
 * so plainly.
 *
 * What IS cached is the artwork, which is immutable and says nothing about
 * anybody.
 */

const CACHE = 'scalivo-me-v1';
const ASSETS = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/app-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing file cannot fail the whole install and
      // leave the page permanently uninstallable.
      .then((cache) => Promise.allSettled(ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    return;
  }

  // Navigations only. A page's own scripts and styles are versioned by the
  // build and fetched normally; intercepting them would buy nothing and give
  // this worker a way to serve a stale bundle after a deploy.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => offlineResponse()));
  }
});

function offlineResponse() {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My appointments</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;color:#0d0d0d;background:#fff;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:340px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#737373;margin:0}</style>
</head><body><main>
<h1>You're offline</h1>
<p>Your appointments are kept up to date on Scalivo, so this page needs a connection. Try again once you're back online.</p>
</main></body></html>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
