import type { ReactNode } from 'react';

import { BusinessRow } from '@/components/BusinessRow';
import { FeatureBusiness } from '@/components/FeatureBusiness';
import { Reveal } from '@/components/Reveal';
import type { BusinessCard } from '@/lib/marketplace';

/**
 * Deliberately unequal. A directory where every entry gets identical weight
 * makes the reader do the ranking; this one does it for them — the best-rated
 * business takes seven columns, the next two run down a ruled rail beside it,
 * and the remainder fall into a two-column ledger of compact rows.
 *
 * On a phone the whole thing is one column of rows, feature first.
 */
export function BusinessLedger({ businesses, empty }: { businesses: BusinessCard[]; empty: ReactNode }) {
  const [feature, ...rest] = businesses;

  if (!feature) return <>{empty}</>;

  const rail = rest.slice(0, 2);
  const ledger = rest.slice(2);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-12 md:gap-x-10">
        <Reveal className="md:col-span-7">
          <FeatureBusiness business={feature} />
        </Reveal>

        {rail.length > 0 ? (
          <div className="mt-10 md:col-span-5 md:mt-0 md:border-l md:border-line md:pl-10">
            <p className="label border-b border-line pb-3 text-muted">Also taking bookings</p>
            {rail.map((business, index) => (
              <Reveal key={business.id} delay={index * 40}>
                <BusinessRow business={business} showServices />
              </Reveal>
            ))}
          </div>
        ) : null}
      </div>

      {ledger.length > 0 ? (
        <div className="mt-14 md:mt-20">
          <p className="label border-b border-line pb-3 text-muted">The rest of the directory</p>
          <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-10">
            {ledger.map((business, index) => (
              <Reveal key={business.id} delay={index * 40}>
                <BusinessRow business={business} />
              </Reveal>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
