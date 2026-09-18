'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ArrowLeft, ArrowRight } from '@/components/Icons';

/**
 * A native horizontal scroller with arrow buttons on top. The items are
 * server-rendered and swipeable without JavaScript; the arrows are the only
 * part that needs it, and they hide themselves at either end.
 */
export function Carousel({ label, children }: { label: string; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const node = track.current;
    if (!node) return;

    const update = () =>
      setEdges({
        start: node.scrollLeft <= 4,
        end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 4,
      });

    update();
    node.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      node.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const scroll = (direction: 1 | -1) => {
    const node = track.current;
    if (node) node.scrollBy({ left: direction * node.clientWidth * 0.9, behavior: 'smooth' });
  };

  const arrow =
    'absolute top-[30%] z-10 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-white shadow-sm transition-colors hover:bg-surface md:flex';

  return (
    <div className="relative">
      <div
        ref={track}
        role="region"
        aria-label={label}
        tabIndex={0}
        className="no-scrollbar -mx-5 flex snap-x snap-mandatory scroll-px-5 gap-4 overflow-x-auto px-5 md:mx-0 md:scroll-px-0 md:gap-7 md:px-0"
      >
        {children}
      </div>

      {edges.start ? null : (
        <button type="button" onClick={() => scroll(-1)} aria-label={`Previous — ${label}`} className={`${arrow} -left-6`}>
          <ArrowLeft />
        </button>
      )}
      {edges.end ? null : (
        <button type="button" onClick={() => scroll(1)} aria-label={`Next — ${label}`} className={`${arrow} -right-6`}>
          <ArrowRight />
        </button>
      )}
    </div>
  );
}

/** One slide: ~1.2 visible on a phone, four across on a wide screen. */
export function Slide({ children }: { children: ReactNode }) {
  return <div className="w-[80%] shrink-0 snap-start sm:w-[45%] lg:w-[calc((100%-84px)/4)]">{children}</div>;
}
