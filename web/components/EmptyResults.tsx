import Link from 'next/link';

import { SearchIcon } from '@/components/Icons';

/** An empty result is a dead end unless it hands back a way forward. */
export function EmptyResults({
  heading,
  body,
  actions,
}: {
  heading: string;
  body: string;
  actions: { href: string; label: string }[];
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-surface px-6 py-16 text-center md:py-20">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white">
        <SearchIcon className="h-6 w-6" />
      </span>
      <h2 className="mt-5 text-[24px] font-bold tracking-[-0.02em]">{heading}</h2>
      <p className="mt-2 max-w-[48ch] text-[16px] text-muted">{body}</p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        {actions.map((action, index) => (
          <Link
            key={action.href}
            href={action.href}
            className={`inline-flex h-12 items-center rounded-full px-6 text-[15px] font-semibold ${
              index === 0 ? 'bg-ink text-white hover:bg-black/80' : 'border border-line bg-white hover:bg-surface'
            }`}
          >
            {action.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
