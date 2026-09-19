'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * The phone's pinned "Book now" bar, slid away while the booking section is
 * on screen — otherwise it sits on top of the very form it points to, over
 * the phone-number field, with the keyboard open.
 */
export function HideWhileBooking({ className, children }: { className: string; children: ReactNode }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const target = document.getElementById('book');
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setHidden(Boolean(entry?.isIntersecting)));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`${className} transition-transform duration-200 motion-reduce:transition-none ${hidden ? 'translate-y-full' : ''}`}
      aria-hidden={hidden}
      // React 19 supports the inert boolean attribute natively
      inert={hidden ? true : undefined}
    >
      {children}
    </div>
  );
}
