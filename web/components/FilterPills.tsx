import Link from 'next/link';

import { categoryLabel, type FacetOption } from '@/lib/marketplace';

/**
 * Category and city filters as links, not client state: each pill is a URL, so
 * a filtered list is server-rendered, shareable, and works with no JavaScript.
 * The active pill is black; `aria-current` tells a screen reader which one.
 */
export function FilterPills({
  basePath,
  categories,
  cities,
  activeCategory,
  activeCity,
  query,
}: {
  basePath: string;
  categories: FacetOption[];
  cities: FacetOption[];
  activeCategory?: string | undefined;
  activeCity?: string | undefined;
  query?: string | undefined;
}) {
  const href = (next: { category?: string | undefined; city?: string | undefined }) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (next.category) params.set('category', next.category);
    if (next.city) params.set('city', next.city);
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <div className="space-y-3">
      <Row label="Category">
        <Pill href={href({ city: activeCity })} active={!activeCategory}>
          All
        </Pill>
        {categories.map((option) => (
          <Pill
            key={option.value}
            href={href({ category: option.value, city: activeCity })}
            active={activeCategory === option.value}
          >
            {categoryLabel(option.value)}
          </Pill>
        ))}
      </Row>
      <Row label="City">
        <Pill href={href({ category: activeCategory })} active={!activeCity}>
          Anywhere
        </Pill>
        {cities.map((option) => (
          <Pill
            key={option.value}
            href={href({ category: activeCategory, city: option.value })}
            active={activeCity === option.value}
          >
            {option.label}
          </Pill>
        ))}
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={`Filter by ${label.toLowerCase()}`} className="no-scrollbar -mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
      <ul className="flex w-max gap-2">{children}</ul>
    </nav>
  );
}

export function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={`inline-flex h-10 items-center rounded-full border px-4 text-[14px] font-semibold whitespace-nowrap transition-colors ${
          active ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:bg-surface'
        }`}
      >
        {children}
      </Link>
    </li>
  );
}
