import { dayName, formatPrice, type MarketplaceBusiness } from '@/lib/marketplace';
import { SITE_URL } from '@/lib/site';

/** Categories mapped to the closest schema.org type, so search engines file it right. */
const SCHEMA_TYPE: Record<string, string> = {
  clinic: 'MedicalClinic',
  salon: 'BeautySalon',
  spa: 'DaySpa',
  gym: 'ExerciseGym',
  barber: 'HairSalon',
};

/**
 * Structured data for the profile. This is what lets a search result show the
 * rating, hours and price range under the link — on a phone, often the whole
 * decision before anyone taps through.
 */
export function LocalBusinessJsonLd({ business }: { business: MarketplaceBusiness }) {
  const prices = business.services.map((service) => service.priceMinor).filter((price) => price > 0);

  const data = {
    '@context': 'https://schema.org',
    '@type': SCHEMA_TYPE[business.category] ?? 'LocalBusiness',
    name: business.name,
    description: business.tagline,
    url: `${SITE_URL}/${business.slug}`,
    ...(business.coverUrl ? { image: new URL(business.coverUrl, SITE_URL).href } : {}),
    ...(business.addressLine
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: business.addressLine,
            ...(business.city ? { addressLocality: business.city } : {}),
            addressCountry: 'PK',
          },
        }
      : {}),
    ...(prices.length > 0
      ? { priceRange: `${formatPrice(Math.min(...prices))}–${formatPrice(Math.max(...prices))}` }
      : {}),
    /**
     * The services themselves, each as a priced Offer.
     *
     * `priceRange` above is a single string and tells a search engine nothing
     * about WHAT costs that much. This is what can put "Hydrafacial · Rs 8,000"
     * under the result — which for a salon is most of the query. Minor units are
     * converted here because schema.org wants a decimal amount, and the currency
     * is named explicitly rather than inferred from the formatting.
     */
    ...(business.services.length > 0
      ? {
          hasOfferCatalog: {
            '@type': 'OfferCatalog',
            name: `Services at ${business.name}`,
            itemListElement: business.services.map((service) => ({
              '@type': 'Offer',
              // Duration is deliberately absent: schema.org has no property for
              // "this service takes 45 minutes" that search engines consume, and
              // inventing one adds weight to the payload for no benefit.
              itemOffered: {
                '@type': 'Service',
                name: service.name,
                ...(service.imageUrl ? { image: service.imageUrl } : {}),
              },
              ...(service.priceMinor > 0
                ? { price: (service.priceMinor / 100).toFixed(2), priceCurrency: 'PKR' }
                : {}),
              availability: 'https://schema.org/InStock',
            })),
          },
        }
      : {}),
    openingHoursSpecification: business.hours.map((entry) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: dayName(entry.dayOfWeek),
      opens: entry.opensAt,
      closes: entry.closesAt,
    })),
    ...(business.rating !== null && business.reviewCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: business.rating,
            reviewCount: business.reviewCount,
          },
        }
      : {}),
  };

  // `<` escaped so a business name can never close the script tag early.
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
