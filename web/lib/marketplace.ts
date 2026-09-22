/**
 * The marketplace data-access layer. Every public page imports from here and
 * nothing else — no page ever calls `fetch` directly.
 *
 * ## Why this file exists in this shape
 *
 * Phase 2.1's DoD says the directory is SEO-indexed and `scalivo.app/<business>`
 * loads fast on mobile data. That is decided by these pages being server
 * components, which in turn means data arrives here, on the server, at render
 * time. The pages must not care whether it came from a fixture or from Express.
 *
 * Two sources implement one interface: the backend's anonymous `/public`
 * namespace, and a fixture for working on the site with no backend running.
 * `MARKETPLACE_SOURCE=http` picks the real one (see SWAP POINT below). No page
 * changes either way.
 */

import type {
  BusinessCard,
  FacetOption,
  FeaturedReview,
  MarketplaceBusiness,
} from '@scalivo/shared';
import { MOCK_BUSINESSES } from './mock-businesses';
import { API_BASE } from './site';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The public contract lives in @scalivo/shared (types/marketplace.ts) now that
 * the backend serves it — one definition, so the API and the pages cannot
 * drift. Re-exported here so pages keep importing from the data layer only.
 */
export type {
  BusinessCard,
  FacetOption,
  FeaturedReview,
  GalleryImage,
  MarketplaceBusiness,
  PublicBookingReceipt,
  PublicHold,
  PublicReview as Review,
  PublicService,
  PublicSlot,
  PublicStaff,
} from '@scalivo/shared';

/** Directory and search filters. Absent means "no constraint", never "none". */
export interface MarketplaceFilters {
  category?: string;
  city?: string;
}

/** What the data layer can answer. Both sources below implement exactly this. */
interface MarketplaceSource {
  listBusinesses(filters: MarketplaceFilters): Promise<BusinessCard[]>;
  searchBusinesses(query: string, filters: MarketplaceFilters): Promise<BusinessCard[]>;
  getBusinessBySlug(slug: string): Promise<MarketplaceBusiness | null>;
  listCategories(): Promise<FacetOption[]>;
  listCities(): Promise<FacetOption[]>;
  /** Every indexable slug, for sitemap.ts. */
  listBusinessSlugs(): Promise<string[]>;
  /** Recent published reviews across every business, newest first. */
  listFeaturedReviews(limit: number): Promise<FeaturedReview[]>;
}

/* -------------------------------------------------------------------------- */
/*  SWAP POINT                                                                 */
/* -------------------------------------------------------------------------- */

export { API_BASE };

/**
 * **This line is the whole migration.** Change the fallback to 'http' once the
 * backend serves the public read namespace, then delete `mockSource` and
 * `lib/mock-businesses.ts` once it is trusted. No page imports either one.
 *
 * Reading the env var first is what lets someone point a local `pnpm dev` at a
 * half-finished public API without editing a file that would then show up in
 * everyone's diff.
 */
const SOURCE = (process.env.MARKETPLACE_SOURCE ?? 'mock') as 'mock' | 'http';

/**
 * Whether the profile page offers real online booking.
 *
 * Only against the real API: the fixtures' service and staff ids exist nowhere
 * a hold could be taken, so booking against them would fail at the first tap.
 * With fixtures, the booking section says "book over WhatsApp" instead.
 */
export const LIVE_BOOKING = SOURCE === 'http';

/**
 * The routes `httpSource` reads, served by backend/src/public/routes.ts:
 *
 *   GET /public/businesses?category=&city=          → BusinessCard[]
 *   GET /public/businesses?q=&category=&city=       → BusinessCard[]
 *   GET /public/businesses/:slug                    → MarketplaceBusiness | 404
 *   GET /public/facets                              → { categories, cities }
 *   GET /public/businesses/slugs                    → string[]
 *   GET /public/reviews?limit=                      → FeaturedReview[]
 *
 * A separate `/public` router rather than the tenant-scoped `/businesses` ones,
 * because tenancy is precisely the idea that cannot apply to an anonymous
 * reader. backend/tests/public.test.ts proves it never returns an unpublished
 * business and never returns a `whatsapp` field.
 */
async function getJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    // Public pages are cacheable and largely static between edits. Revalidating
    // rather than rendering per-request is what keeps them fast on mobile data.
    next: { revalidate: 300 },
  });

  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

const httpSource: MarketplaceSource = {
  listBusinesses: (filters) =>
    getJson<BusinessCard[]>('/public/businesses', { category: filters.category, city: filters.city }),

  searchBusinesses: (query, filters) =>
    getJson<BusinessCard[]>('/public/businesses', {
      q: query,
      category: filters.category,
      city: filters.city,
    }),

  getBusinessBySlug: async (slug) => {
    try {
      return await getJson<MarketplaceBusiness>(`/public/businesses/${encodeURIComponent(slug)}`);
    } catch {
      // A missing business is an ordinary outcome on a public URL someone typed,
      // not an error condition. The page turns this into notFound().
      return null;
    }
  },

  listCategories: async () =>
    (await getJson<{ categories: FacetOption[] }>('/public/facets')).categories,

  listCities: async () => (await getJson<{ cities: FacetOption[] }>('/public/facets')).cities,

  listBusinessSlugs: () => getJson<string[]>('/public/businesses/slugs'),

  listFeaturedReviews: (limit) => getJson<FeaturedReview[]>('/public/reviews', { limit: String(limit) }),
};

/* -------------------------------------------------------------------------- */
/*  Mock source                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `Business.published` gates the marketplace — shared/types/business.ts calls it
 * "hidden from the marketplace until the minimum profile fields are set". Every
 * read path applies it, so an unpublished fixture can never reach a page, the
 * sitemap, or a card. The HTTP source must enforce the same thing server-side;
 * a filter that only exists in the client is not a filter.
 */
const published = () => MOCK_BUSINESSES.filter((business) => business.published);

function toCard(business: MarketplaceBusiness): BusinessCard {
  const prices = business.services.map((service) => service.priceMinor);

  return {
    id: business.id,
    slug: business.slug,
    name: business.name,
    category: business.category,
    city: business.city,
    neighbourhood: business.neighbourhood,
    tagline: business.tagline,
    coverUrl: business.coverUrl,
    logoUrl: business.logoUrl,
    rating: business.rating,
    reviewCount: business.reviewCount,
    fromPriceMinor: prices.length > 0 ? Math.min(...prices) : null,
    featured: false,
    popularServices: [...business.services]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .slice(0, 3)
      .map((service) => service.name),
  };
}

const matchesFilters = (business: MarketplaceBusiness, filters: MarketplaceFilters) =>
  (!filters.category || business.category === filters.category) &&
  (!filters.city || business.city === filters.city);

/**
 * Deliberately generous: a customer searching "facial" should find a clinic that
 * offers one even though the word is nowhere in its name. Matching across
 * services and staff is what makes the directory feel like it knows its
 * businesses rather than doing a string compare on the title.
 */
function matchesQuery(business: MarketplaceBusiness, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    business.name,
    business.tagline,
    business.about,
    business.category,
    business.city ?? '',
    business.neighbourhood ?? '',
    ...business.services.map((service) => service.name),
    ...business.staff.map((member) => member.name),
  ]
    .join(' ')
    .toLowerCase();

  // Every word has to appear somewhere. "multan gym" should not match a Lahore
  // gym just because one of the two words hit.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

function facets(pick: (business: MarketplaceBusiness) => string | null): FacetOption[] {
  const counts = new Map<string, number>();
  for (const business of published()) {
    const value = pick(business);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: titleCase(value), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Well-reviewed first, then most-reviewed. Unrated businesses sort last. */
const byRelevance = (a: MarketplaceBusiness, b: MarketplaceBusiness) =>
  (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount;

const mockSource: MarketplaceSource = {
  listBusinesses: async (filters) =>
    published()
      .filter((business) => matchesFilters(business, filters))
      .sort(byRelevance)
      .map(toCard),

  searchBusinesses: async (query, filters) =>
    published()
      .filter((business) => matchesFilters(business, filters) && matchesQuery(business, query))
      .sort(byRelevance)
      .map(toCard),

  getBusinessBySlug: async (slug) =>
    published().find((business) => business.slug === slug) ?? null,

  listCategories: async () => facets((business) => business.category),
  listCities: async () => facets((business) => business.city),
  listBusinessSlugs: async () => published().map((business) => business.slug),

  listFeaturedReviews: async (limit) =>
    published()
      .flatMap((business) =>
        business.reviews.map((review) => ({ ...review, businessName: business.name, businessSlug: business.slug })),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit),
};

/* -------------------------------------------------------------------------- */
/*  Public API — the only thing pages import                                   */
/* -------------------------------------------------------------------------- */

const source: MarketplaceSource = SOURCE === 'http' ? httpSource : mockSource;

export const listBusinesses = (filters: MarketplaceFilters = {}) => source.listBusinesses(filters);

export const searchBusinesses = (query: string, filters: MarketplaceFilters = {}) =>
  source.searchBusinesses(query, filters);

export const getBusinessBySlug = (slug: string) => source.getBusinessBySlug(slug);

export const listCategories = () => source.listCategories();

export const listCities = () => source.listCities();

export const listBusinessSlugs = () => source.listBusinessSlugs();

export const listFeaturedReviews = (limit = 8) => source.listFeaturedReviews(limit);

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export { formatDuration, formatPrice } from './format';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayName = (dayOfWeek: number) => DAY_NAMES[dayOfWeek] ?? '';

/** '09:00' → '9:00 AM'. Wall-clock in the business timezone; no Date involved. */
export function formatTime(wallClock: string): string {
  const [hourPart, minutePart] = wallClock.split(':');
  const hour = Number(hourPart);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minutePart} ${suffix}`;
}

export const titleCase = (value: string) =>
  value.replace(/(^|[\s-])([a-z])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase());

/** 'clinic' → 'Clinics'. Used for headings and filter chips. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? titleCase(category);
}

const CATEGORY_LABELS: Record<string, string> = {
  clinic: 'Clinic',
  salon: 'Salon',
  gym: 'Gym',
  spa: 'Spa',
  studio: 'Studio',
  barber: 'Barber',
};
