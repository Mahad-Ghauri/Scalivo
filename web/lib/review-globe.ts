import type { GlobeTestimonial } from '@/components/ui/testimonial-globe';
import type { BusinessCard, FeaturedReview } from '@/lib/marketplace';

/**
 * Where each city sits on the globe. Matches the city list on the app's sign-up
 * screen; a review from a city missing here is left off the globe (it still
 * counts in the totals), so add a row when a new city goes live.
 */
const CITY_COORDINATES: Record<string, { lat: number; lng: number; country: string }> = {
  Multan: { lat: 30.16, lng: 71.52, country: 'PK' },
  Lahore: { lat: 31.55, lng: 74.34, country: 'PK' },
  Karachi: { lat: 24.86, lng: 67.01, country: 'PK' },
  Islamabad: { lat: 33.68, lng: 73.05, country: 'PK' },
  Rawalpindi: { lat: 33.6, lng: 73.04, country: 'PK' },
  Faisalabad: { lat: 31.42, lng: 73.08, country: 'PK' },
  Peshawar: { lat: 34.01, lng: 71.58, country: 'PK' },
  Quetta: { lat: 30.18, lng: 66.98, country: 'PK' },
  Hyderabad: { lat: 25.4, lng: 68.37, country: 'PK' },
  Gujranwala: { lat: 32.19, lng: 74.19, country: 'PK' },
  Sialkot: { lat: 32.49, lng: 74.53, country: 'PK' },
  Bahawalpur: { lat: 29.4, lng: 71.68, country: 'PK' },
};

/**
 * Degrees between neighbouring pins from one city. A face pin is ~14° wide on
 * the globe, so reviews from the same city are fanned out in a small spiral
 * around it rather than stacked into what looks like one pin. The card still
 * names the real city.
 */
const SPREAD = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Featured reviews as globe pins, each placed at its business's city. */
export function toGlobeTestimonials(reviews: FeaturedReview[], businesses: BusinessCard[]): GlobeTestimonial[] {
  const cityOf = new Map(businesses.map((business) => [business.slug, business.city]));
  const placed = new Map<string, number>();
  const items: GlobeTestimonial[] = [];

  for (const review of reviews) {
    const city = cityOf.get(review.businessSlug);
    const spot = city ? CITY_COORDINATES[city] : undefined;
    if (!city || !spot) continue;

    const k = placed.get(city) ?? 0;
    placed.set(city, k + 1);
    const distance = k === 0 ? 0 : SPREAD * Math.sqrt(k);
    const angle = k * GOLDEN_ANGLE;

    items.push({
      // Review ids are only unique within a business.
      id: `${review.businessSlug}:${review.id}`,
      quote: review.comment,
      name: review.authorName,
      ...(review.serviceName ? { role: review.serviceName } : {}),
      company: review.businessName,
      city,
      country: spot.country,
      lat: spot.lat + distance * Math.sin(angle),
      lng: spot.lng + (distance * Math.cos(angle)) / Math.cos((spot.lat * Math.PI) / 180),
      image: null,
      rating: review.rating,
    });
  }

  return items;
}
