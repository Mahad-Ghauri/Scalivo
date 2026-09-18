import { GridIcon, PinIcon, SearchIcon } from '@/components/Icons';
import { categoryLabel, type FacetOption } from '@/lib/marketplace';

/**
 * The three-part search pill. A plain GET form: it works with JavaScript off,
 * and the result is a shareable /search URL rendered on the server.
 *
 * `hero` is the tall home-page version; `compact` sits in the header of every
 * other page.
 */
export function SearchBar({
  variant,
  categories,
  cities,
  query = '',
  category,
  city,
}: {
  variant: 'hero' | 'compact';
  categories: FacetOption[];
  cities: FacetOption[];
  query?: string;
  category?: string | undefined;
  city?: string | undefined;
}) {
  const hero = variant === 'hero';
  // On a phone the header version is one field: the pickers would push the page under three rows of form.
  const desktopOnly = hero ? '' : 'hidden md:flex';
  const segment = `flex min-w-0 flex-1 items-center gap-3 ${hero ? 'px-5 py-4 md:py-0' : 'px-4 py-2.5 md:py-0'}`;
  const field = `w-full min-w-0 appearance-none bg-transparent text-ink outline-none placeholder:text-ink ${
    hero ? 'text-[15px]' : 'text-[14px]'
  }`;

  return (
    <form
      action="/search"
      method="get"
      role="search"
      className={`flex flex-col overflow-hidden bg-white md:flex-row md:items-center ${
        hero
          ? 'search-glow rounded-3xl md:h-16 md:rounded-full md:pr-2'
          : 'rounded-2xl border border-line md:h-12 md:rounded-full md:pr-1.5'
      }`}
    >
      <label className={segment}>
        <SearchIcon className="h-5 w-5 shrink-0 text-muted" />
        <span className="sr-only">Treatment or business</span>
        <input type="search" name="q" defaultValue={query} placeholder="All treatments" className={field} />
      </label>

      <span className={`mx-5 h-px bg-line md:mx-0 md:h-8 md:w-px ${desktopOnly}`} aria-hidden="true" />

      <label className={`${segment} ${desktopOnly}`}>
        <PinIcon className="h-5 w-5 shrink-0 text-muted" />
        <span className="sr-only">City</span>
        <select name="city" defaultValue={city ?? ''} className={`${field} cursor-pointer`}>
          <option value="">Any city</option>
          {cities.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <span className={`mx-5 h-px bg-line md:mx-0 md:h-8 md:w-px ${desktopOnly}`} aria-hidden="true" />

      <label className={`${segment} ${desktopOnly}`}>
        <GridIcon className="h-5 w-5 shrink-0 text-muted" />
        <span className="sr-only">Category</span>
        <select name="category" defaultValue={category ?? ''} className={`${field} cursor-pointer`}>
          <option value="">All categories</option>
          {categories.map((option) => (
            <option key={option.value} value={option.value}>
              {categoryLabel(option.value)}
            </option>
          ))}
        </select>
      </label>

      <div className={hero ? 'p-3 md:p-0' : 'p-2 md:p-0'}>
        <button
          type="submit"
          className={`w-full rounded-full bg-ink font-semibold text-white transition-colors hover:bg-black/80 md:w-auto ${
            hero ? 'h-12 px-6 text-[16px]' : 'h-10 px-5 text-[14px]'
          }`}
        >
          Search
        </button>
      </div>
    </form>
  );
}
