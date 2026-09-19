import { formatPrice } from '@/lib/marketplace';

/** Zero paisa means genuinely free — a free intro session — never "PKR 0". */
export function FromPrice({ priceMinor, align = 'right' }: { priceMinor: number | null; align?: 'left' | 'right' }) {
  if (priceMinor === null) {
    return <p className="label text-muted">Prices on request</p>;
  }

  return (
    <p className={align === 'right' ? 'text-right' : ''}>
      <span className="label block text-muted">{priceMinor === 0 ? 'First session' : 'From'}</span>
      <span
        className={`num text-[0.9375rem] font-medium ${priceMinor === 0 ? 'text-clay-deep' : 'text-ink'}`}
      >
        {priceMinor === 0 ? 'Free' : formatPrice(priceMinor)}
      </span>
    </p>
  );
}
