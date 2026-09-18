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
 * Right now it comes from a fixture. The backend exists but **has no public
 * read surface**: every route under `backend/src/` is mounted behind
 * `requireAuth, requireTenant()`, and a stranger opening `scalivo.app/skinare`
 * carries no JWT and belongs to no business. Building that public namespace is
 * backend work (see SWAP POINT below) and is tracked as the other half of 2.1.
 *
 * So: two sources implementing one interface, chosen by one constant. When the
 * public routes land, flip `SOURCE` to 'http'. No page changes.
 */

import type { Business, Service, Staff, WorkingHours } from '@scalivo/shared';
import { MOCK_BUSINESSES } from './mock-businesses';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Fields below that are NOT in @scalivo/shared are marked `[web-only]`. They are
 * defined here rather than added to shared/ deliberately — shared/ is the
 * backend↔web API contract and adding speculative presentation fields to it
 * would make the backend responsible for shipping them before it has a public
 * route to ship them on. When the public endpoints are built, the ones that
 * survive contact with the API move into shared/types/business.ts and these
 * local declarations are deleted.
 */

/**
 * A photo on a business profile.
 *
 * [web-only] — no equivalent in shared/. Owner-uploaded media is 2.1's "bounded
 * owner customisation (logo, cover, theme colour, ordered services)".
 */
export interface GalleryImage {
  url: string;
  /** Never optional. A profile gallery with empty alt text is unusable on a screen reader. */
  alt: string;
}

/**
 * A published review.
 *
 * [web-only] — reviews are milestone 2.2, which has no types in shared/ yet.
 * Note the shape already encodes 2.2's rule: only 4–5 star ratings are
 * published, so anything this layer returns is a rating of 4 or 5. Ratings of
 * 3 and below are flagged privately to the owner and never reach this surface.
 */
export interface Review {
  id: string;
  authorName: string;
  /** 4 or 5. See above — lower ratings are not published. */
  rating: number;
  comment: string;
  /** ISO 8601. A string, not a Date: this crosses the server→client boundary. */
  createdAt: string;
  /** Which service was reviewed, when the rating request named one. */
  serviceName: string | null;
}

/**
 * A service as a customer sees it.
 *
 * Derived from shared's `Service` so the price and duration semantics cannot
 * drift: `priceMinor` is paisa (800_000 = PKR 8,000), matching the seed at
 * backend/src/scripts/seed.ts. `businessId`, `bufferMinutes` and `active` are
 * dropped — turnaround time and retirement state are the owner's business, not
 * the customer's.
 */
export type PublicService = Pick<
  Service,
  'id' | 'name' | 'durationMinutes' | 'priceMinor' | 'depositRequired' | 'depositAmountMinor' | 'displayOrder'
> & {
  /** [web-only] One line of plain-language description. */
  description: string | null;
};

/**
 * A staff member as a customer sees it.
 *
 * `workingHours` is deliberately NOT here. Per-person schedules are exactly the
 * thing a public page must not publish — it would broadcast when each named
 * individual is alone in the building. Availability is answered by asking for
 * slots, never by exposing the pattern behind them.
 */
export type PublicStaff = Pick<Staff, 'id' | 'name' | 'serviceIds'> & {
  /** [web-only] "Aesthetic physician", "Head coach". */
  role: string | null;
  /** [web-only] */
  avatarUrl: string | null;
};

/**
 * A business on the directory grid.
 *
 * Deliberately smaller than the full profile: the directory renders up to a few
 * dozen of these on a phone, and shipping every service, staff member and review
 * for each one is how a directory stops loading fast on mobile data.
 */
export interface BusinessCard {
  id: string;
  slug: string;
  name: string;
  category: string;
  city: string | null;
  /** [web-only] */
  neighbourhood: string | null;
  /** [web-only] The one-line hook shown under the name. */
  tagline: string;
  /** [web-only] */
  coverUrl: string | null;
  /** [web-only] */
  logoUrl: string | null;
  /** [web-only] Mean of published reviews; null until there are any. */
  rating: number | null;
  /** [web-only] */
  reviewCount: number;
  /** [web-only] Cheapest active service, in paisa. Drives the "from PKR x" line. */
  fromPriceMinor: number | null;
  /** [web-only] A few service names, for scanning. Not the full list. */
  popularServices: string[];
}

/**
 * A full public business profile.
 *
 * `Omit<Business, 'whatsapp'>` is load-bearing, not tidiness. `Business.whatsapp`
 * carries `sessionId`, `apiKeyRef`, `status` and `reconnectAttempts` — a
 * credential reference and a live operational health signal. Structurally
 * removing it here means no public page can leak it even by accident, and it
 * means the future `GET /public/businesses/:slug` has a typed reason to project
 * those fields away.
 */
export interface MarketplaceBusiness extends Omit<Business, 'whatsapp'> {
  /** [web-only] */
  tagline: string;
  /** [web-only] Two or three sentences. Rendered as prose, not markdown. */
  about: string;
  /** [web-only] */
  neighbourhood: string | null;
  /** [web-only] Street address, shown but not linked to a map in this phase. */
  addressLine: string | null;
  /** [web-only] */
  logoUrl: string | null;
  /** [web-only] */
  coverUrl: string | null;
  /** [web-only] 2.1's bounded customisation: one hex accent the owner picks. */
  themeColor: string | null;
  /** [web-only] */
  gallery: GalleryImage[];
  /**
   * [web-only] Opening hours for the BUSINESS.
   *
   * shared/ models `workingHours` per `Staff` only, because availability is
   * computed per person. A customer reading a profile wants one answer to "are
   * they open Sunday?", so the public surface publishes the business-level
   * envelope instead. Reuses shared's `WorkingHours` shape — local wall-clock,
   * interpreted in `timezone`, never a UTC instant.
   */
  hours: WorkingHours[];
  /** [web-only] */
  rating: number | null;
  /** [web-only] */
  reviewCount: number;
  services: PublicService[];
  staff: PublicStaff[];
  reviews: Review[];
}

/** A review shown away from its business — the home page carousel. */
export interface FeaturedReview extends Review {
  businessName: string;
  businessSlug: string;
}

/** Directory and search filters. Absent means "no constraint", never "none". */
export interface MarketplaceFilters {
  category?: string;
  city?: string;
}

/** A filter option plus how many published businesses it would match. */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
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

/**
 * Where the real API will live. Public and unauthenticated by design — these
 * pages are rendered for people with no account.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

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
 * The routes `httpSource` expects. None of them exist yet — this is the
 * contract the backend half of 2.1 has to satisfy:
 *
 *   GET /public/businesses?category=&city=          → BusinessCard[]
 *   GET /public/businesses?q=&category=&city=       → BusinessCard[]
 *   GET /public/businesses/:slug                    → MarketplaceBusiness | 404
 *   GET /public/facets                              → { categories, cities }
 *   GET /public/businesses/slugs                    → string[]
 *   GET /public/reviews?limit=                      → FeaturedReview[]
 *
 * They CANNOT be mounted under the existing `/businesses` routers. Every one of
 * those is `requireAuth, requireTenant()`, and tenancy is precisely the thing
 * that does not apply to an anonymous reader. A separate `/public` router with
 * its own tests — including one proving it never returns an unpublished business
 * and never returns a `whatsapp` field — is the safe shape.
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

/**
 * Paisa → "Rs 8,000" (en-PK's own currency symbol). Minor units all the way to the edge: a price is never a
 * float anywhere in this codebase, and this is the only place it becomes text.
 */
export function formatPrice(priceMinor: number): string {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    maximumFractionDigits: 0,
  }).format(priceMinor / 100);
}

/** 45 → "45 min", 90 → "1 hr 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

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
