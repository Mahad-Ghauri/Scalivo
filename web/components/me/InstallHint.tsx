'use client';

import { useEffect, useState } from 'react';

/**
 * Registers the service worker, and offers the install where the browser lets
 * us offer it.
 *
 * Two halves, and they are independent on purpose:
 *
 * 1. **Registration** is what makes the page installable at all. Scope is
 *    pinned to `/me/` — see public/sw.js for why a root-scoped worker in front
 *    of the whole site would be the wrong trade.
 * 2. **The button** only appears if Chrome fires `beforeinstallprompt`. Safari
 *    never does — on iOS, Add to Home Screen is a Share-sheet action nobody can
 *    trigger from script — so iOS gets a sentence telling them where it is
 *    rather than a button that cannot work.
 *
 * Nothing here is load-bearing. The page works uninstalled, and a browser that
 * supports none of this shows one line of text.
 */

/** The event Chrome fires, which is not in the DOM lib's types. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Failure is not worth surfacing: it costs installability, not the page.
      // Private windows and unsupported browsers both land here.
      navigator.serviceWorker.register('/sw.js', { scope: '/me/' }).catch(() => undefined);
    }

    // Already running from the home screen: there is nothing to offer.
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);

    const onPrompt = (event: Event) => {
      // Chrome shows its own mini-infobar unless this is cancelled, and that bar
      // appears over the appointment the customer opened the page to read.
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;

  return (
    <section className="mt-10 rounded-2xl border border-line bg-surface p-6">
      <h2 className="text-[16px] font-bold tracking-[-0.02em]">Keep this on your phone</h2>
      {prompt ? (
        <>
          <p className="mt-1 text-[15px] text-muted">
            Add it to your home screen and your appointments are one tap away.
          </p>
          <button
            type="button"
            onClick={() => {
              void prompt.prompt();
              // Whatever they choose, the event cannot be reused — Chrome fires
              // a fresh one if they become eligible again.
              setPrompt(null);
            }}
            className="mt-4 inline-flex h-11 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80"
          >
            Add to home screen
          </button>
        </>
      ) : (
        <p className="mt-1 text-[15px] text-muted">
          Add this page to your home screen from your browser&rsquo;s share menu, and your appointments are
          one tap away.
        </p>
      )}
    </section>
  );
}
