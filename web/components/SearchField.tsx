import { ArrowEast } from '@/components/Icons';

/**
 * A plain GET form. No client JS, no debounce, no fetch — the results page is
 * server-rendered and the URL it produces is shareable, which is the whole
 * point of a search that lives on an SEO surface.
 */
export function SearchField({
  defaultValue = '',
  category,
  city,
  tone = 'hero',
}: {
  defaultValue?: string;
  category?: string | undefined;
  city?: string | undefined;
  tone?: 'hero' | 'compact';
}) {
  const hero = tone === 'hero';

  return (
    <form method="get" action="/search" role="search" className="w-full">
      {category ? <input type="hidden" name="category" value={category} /> : null}
      {city ? <input type="hidden" name="city" value={city} /> : null}

      <label htmlFor="q" className="label block text-muted">
        Search the directory
      </label>

      <div
        className={`mt-2 flex items-end gap-3 border-b-2 border-ink ${hero ? 'pb-2' : 'pb-1.5'} focus-within:border-kashi`}
      >
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={defaultValue}
          autoComplete="off"
          placeholder="Hydrafacial, barber, Dr. Ayesha"
          className={`ledger-input min-w-0 flex-1 bg-transparent font-sans font-medium text-ink outline-none ${
            hero ? 'text-[1.375rem] md:text-[1.75rem]' : 'text-[1.0625rem]'
          }`}
        />
        <button
          type="submit"
          className={`label-lg group flex shrink-0 items-center gap-2 bg-kashi px-4 text-paper transition-colors duration-150 hover:bg-kashi-deep ${
            hero ? 'py-2.5' : 'py-2'
          }`}
        >
          Search
          <ArrowEast className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </button>
      </div>
    </form>
  );
}
