import { FilterChip } from '@/components/FilterChip';
import { categoryLabel, type FacetOption } from '@/lib/marketplace';

/**
 * Filters are links, not client state. The filtered view is a real URL that
 * renders on the server, so it can be shared, indexed, and opened on a phone
 * with the JS still loading.
 */
export function FilterBar({
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

  const rows = [
    {
      key: 'category',
      heading: 'Category',
      allLabel: 'Everything',
      active: activeCategory,
      options: categories.map((option) => ({
        ...option,
        label: categoryLabel(option.value),
        href: href({ category: option.value, city: activeCity }),
      })),
      allHref: href({ city: activeCity }),
    },
    {
      key: 'city',
      heading: 'City',
      allLabel: 'Anywhere',
      active: activeCity,
      options: cities.map((option) => ({
        ...option,
        href: href({ category: activeCategory, city: option.value }),
      })),
      allHref: href({ category: activeCategory }),
    },
  ];

  return (
    <section aria-labelledby="filters-heading" className="border-y border-line">
      <h2 id="filters-heading" className="sr-only">
        Filter the directory
      </h2>

      {rows.map((row, index) => (
        <div
          key={row.key}
          className={`flex flex-wrap items-center gap-x-2 gap-y-2 py-3 md:gap-x-3 ${
            index > 0 ? 'border-t border-line' : ''
          }`}
        >
          <span className="label w-full shrink-0 text-muted md:w-[88px]">{row.heading}</span>

          <FilterChip href={row.allHref} active={!row.active} label={row.allLabel} />
          {row.options.map((option) => (
            <FilterChip
              key={option.value}
              href={option.href}
              active={row.active === option.value}
              label={option.label}
              count={option.count}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
