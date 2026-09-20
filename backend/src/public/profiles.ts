import {
  REVIEW_PUBLISH_MIN_RATING,
  type BusinessCard,
  type FacetOption,
  type FeaturedReview,
  type MarketplaceBusiness,
  type PublicReview,
  type PublicService,
  type PublicStaff,
  type WorkingHours,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Review } from '../models/Review.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';

/**
 * The public projections: what a stranger with no account may read.
 *
 * Every function builds its output field by field from an explicit list. None
 * spreads a document. A spread would publish whatever the schema grows next —
 * and `Business` already carries a WhatsApp session id and an API key
 * reference, so "whatever the schema grows" is not hypothetical.
 *
 * Every read starts from PUBLISHED, and there is no parameter to turn that off.
 */

/** Only these fields are ever loaded from a Business on this path. */
const BUSINESS_FIELDS =
  'slug name category city timezone slotIncrementMinutes minNoticeMinutes bookingHorizonDays published profile';

const PUBLISHED = { published: true } as const;

/** 2.2's rule, enforced at the read as well as the write: 4–5 stars and flagged public. */
const PUBLIC_REVIEW = { published: true, rating: { $gte: REVIEW_PUBLISH_MIN_RATING } } as const;

type BusinessDoc = Awaited<ReturnType<typeof loadBusinesses>>[number];
type ServiceDoc = InstanceType<typeof Service>;
type StaffDoc = InstanceType<typeof Staff>;

function loadBusinesses(filter: Record<string, unknown>) {
  return Business.find({ ...filter, ...PUBLISHED }).select(BUSINESS_FIELDS);
}

/** Mean rating and count per business, over published reviews only. */
async function ratingsFor(businessIds: string[]): Promise<Map<string, { rating: number; count: number }>> {
  const rows = await Review.aggregate<{ _id: string; rating: number; count: number }>([
    { $match: { businessId: { $in: businessIds }, ...PUBLIC_REVIEW } },
    { $group: { _id: '$businessId', rating: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  // One decimal, so 4.866 reads as the 4.9 the stars draw.
  return new Map(rows.map((row) => [row._id, { rating: Math.round(row.rating * 10) / 10, count: row.count }]));
}

/**
 * The business's opening envelope, derived from its people.
 *
 * Availability is modelled per staff member, so there is no business-level
 * "hours" to read. A customer asking "are they open Sunday?" gets the span from
 * the earliest opening to the latest closing across everyone working that day.
 * A break is published only when EVERY person working that day takes it —
 * otherwise someone is still in, and the business is open.
 */
export function businessHours(staff: readonly Pick<StaffDoc, 'workingHours'>[]): WorkingHours[] {
  const hours: WorkingHours[] = [];

  for (let day = 0; day < 7; day++) {
    const shifts = staff
      .map((member) => member.workingHours.find((h) => h.dayOfWeek === day))
      .filter((shift): shift is NonNullable<typeof shift> => Boolean(shift));
    if (shifts.length === 0) continue;

    // 'HH:MM' compares correctly as a string.
    const opensAt = shifts.map((s) => s.opensAt).sort()[0]!;
    const closesAt = shifts.map((s) => s.closesAt).sort().at(-1)!;

    const breaksOf = (shift: (typeof shifts)[number]) =>
      shift.breaks.flatMap((b) => (b.startsAt && b.endsAt ? [{ startsAt: b.startsAt, endsAt: b.endsAt }] : []));

    const shared = breaksOf(shifts[0]!).filter((candidate) =>
      shifts.every((shift) =>
        breaksOf(shift).some((b) => b.startsAt === candidate.startsAt && b.endsAt === candidate.endsAt),
      ),
    );

    hours.push({ dayOfWeek: day, opensAt, closesAt, breaks: shared });
  }

  return hours;
}

function toPublicService(service: ServiceDoc): PublicService {
  return {
    id: String(service._id),
    name: service.name,
    description: service.description ?? null,
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    depositRequired: service.depositRequired,
    depositAmountMinor: service.depositAmountMinor ?? null,
    displayOrder: service.displayOrder,
  };
}

function toPublicStaff(member: StaffDoc, activeServiceIds: Set<string>): PublicStaff {
  return {
    id: String(member._id),
    name: member.name,
    role: member.role ?? null,
    avatarUrl: member.avatarUrl ?? null,
    // A retired service is not something this person can be booked for.
    serviceIds: member.serviceIds.filter((id) => activeServiceIds.has(id)),
  };
}

function toPublicReview(review: InstanceType<typeof Review>): PublicReview {
  return {
    id: String(review._id),
    authorName: review.authorName,
    rating: review.rating,
    comment: review.comment,
    createdAt: (review.createdAt ?? new Date(0)).toISOString(),
    serviceName: review.serviceName ?? null,
  };
}

function toCard(
  business: BusinessDoc,
  services: ServiceDoc[],
  rating: { rating: number; count: number } | undefined,
): BusinessCard {
  const prices = services.map((s) => s.priceMinor);
  return {
    id: String(business._id),
    slug: business.slug,
    name: business.name,
    category: business.category,
    city: business.city ?? null,
    neighbourhood: business.profile?.neighbourhood ?? null,
    tagline: business.profile?.tagline ?? '',
    coverUrl: business.profile?.coverUrl ?? null,
    logoUrl: business.profile?.logoUrl ?? null,
    rating: rating?.rating ?? null,
    reviewCount: rating?.count ?? 0,
    fromPriceMinor: prices.length > 0 ? Math.min(...prices) : null,
    popularServices: services.slice(0, 3).map((s) => s.name),
  };
}

/**
 * Every word must appear somewhere across the business and what it offers, so
 * "facial" finds a clinic without the word in its name, and "multan gym" does
 * not match a Lahore gym. Same rule as the web's fixture source.
 */
function matchesQuery(haystack: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = haystack.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The directory, optionally searched.
 *
 * Search runs in memory over every published business. That is fine at pilot
 * scale — a few dozen businesses — and it is the thing to replace with a text
 * index before the directory has thousands. It is not the thing to optimise now.
 */
export async function listBusinesses(filters: {
  category?: string | undefined;
  city?: string | undefined;
  q?: string | undefined;
}): Promise<BusinessCard[]> {
  const businesses = await loadBusinesses({
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.city ? { city: filters.city } : {}),
  });
  if (businesses.length === 0) return [];

  const ids = businesses.map((b) => String(b._id));
  const [services, staff, ratings] = await Promise.all([
    Service.find({ businessId: { $in: ids }, active: true }).sort({ displayOrder: 1 }),
    filters.q ? Staff.find({ businessId: { $in: ids }, active: true }).select('businessId name') : [],
    ratingsFor(ids),
  ]);

  const servicesOf = (id: string) => services.filter((s) => s.businessId === id);

  return businesses
    .filter((business) => {
      if (!filters.q) return true;
      const id = String(business._id);
      const haystack = [
        business.name,
        business.category,
        business.city ?? '',
        business.profile?.tagline ?? '',
        business.profile?.about ?? '',
        business.profile?.neighbourhood ?? '',
        ...servicesOf(id).map((s) => s.name),
        ...staff.filter((m) => m.businessId === id).map((m) => m.name),
      ].join(' ');
      return matchesQuery(haystack, filters.q);
    })
    .map((business) => {
      const id = String(business._id);
      return toCard(business, servicesOf(id), ratings.get(id));
    })
    // Well-reviewed first, then most-reviewed; unrated last.
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount);
}

/** How many reviews a profile page carries. The rating and count still cover all of them. */
const PROFILE_REVIEW_LIMIT = 20;

export async function getBusinessBySlug(slug: string): Promise<MarketplaceBusiness | null> {
  const business = await Business.findOne({ slug, ...PUBLISHED }).select(BUSINESS_FIELDS);
  if (!business) return null;

  const businessId = String(business._id);
  const [services, staff, reviews, ratings] = await Promise.all([
    Service.find({ businessId, active: true }).sort({ displayOrder: 1 }),
    Staff.find({ businessId, active: true }).sort({ createdAt: 1 }),
    Review.find({ businessId, ...PUBLIC_REVIEW }).sort({ createdAt: -1 }).limit(PROFILE_REVIEW_LIMIT),
    ratingsFor([businessId]),
  ]);

  const activeServiceIds = new Set(services.map((s) => String(s._id)));
  const rating = ratings.get(businessId);
  const profile = business.profile;

  return {
    id: businessId,
    slug: business.slug,
    name: business.name,
    category: business.category,
    city: business.city ?? null,
    timezone: business.timezone,
    slotIncrementMinutes: business.slotIncrementMinutes,
    minNoticeMinutes: business.minNoticeMinutes,
    bookingHorizonDays: business.bookingHorizonDays,
    published: true,
    tagline: profile?.tagline ?? '',
    about: profile?.about ?? '',
    neighbourhood: profile?.neighbourhood ?? null,
    addressLine: profile?.addressLine ?? null,
    logoUrl: profile?.logoUrl ?? null,
    coverUrl: profile?.coverUrl ?? null,
    themeColor: profile?.themeColor ?? null,
    gallery: (profile?.gallery ?? []).map((image) => ({ url: image.url, alt: image.alt })),
    hours: businessHours(staff),
    rating: rating?.rating ?? null,
    reviewCount: rating?.count ?? 0,
    services: services.map(toPublicService),
    staff: staff.map((member) => toPublicStaff(member, activeServiceIds)),
    reviews: reviews.map(toPublicReview),
  };
}

/** The published id for a slug, or null. The gate every public booking call goes through. */
export async function publishedBusinessId(slug: string): Promise<string | null> {
  const business = await Business.findOne({ slug, ...PUBLISHED }).select('_id');
  return business ? String(business._id) : null;
}

export async function listSlugs(): Promise<string[]> {
  const businesses = await Business.find(PUBLISHED).select('slug').sort({ slug: 1 });
  return businesses.map((b) => b.slug);
}

const titleCase = (value: string) =>
  value.replace(/(^|[\s-])([a-z])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase());

export async function facets(): Promise<{ categories: FacetOption[]; cities: FacetOption[] }> {
  const count = async (field: 'category' | 'city'): Promise<FacetOption[]> => {
    const rows = await Business.aggregate<{ _id: string; count: number }>([
      { $match: { ...PUBLISHED, [field]: { $type: 'string', $ne: '' } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
    return rows
      .map((row) => ({ value: row._id, label: titleCase(row._id), count: row.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  const [categories, cities] = await Promise.all([count('category'), count('city')]);
  return { categories, cities };
}

/**
 * Recent published reviews across the marketplace, newest first.
 *
 * Joined against PUBLISHED businesses, not just published reviews: a business
 * that unpublishes takes its reviews off the home page with it.
 */
export async function featuredReviews(limit: number): Promise<FeaturedReview[]> {
  const businesses = await Business.find(PUBLISHED).select('slug name');
  const byId = new Map(businesses.map((b) => [String(b._id), b]));

  const reviews = await Review.find({ businessId: { $in: [...byId.keys()] }, ...PUBLIC_REVIEW })
    .sort({ createdAt: -1 })
    .limit(limit);

  return reviews.map((review) => {
    const business = byId.get(review.businessId)!;
    return { ...toPublicReview(review), businessName: business.name, businessSlug: business.slug };
  });
}
