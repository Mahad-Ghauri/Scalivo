import { Khatam } from '@/components/Icons';

/**
 * Cover art is a kashi tile plate, not a photograph, and `coverUrl` is nullable
 * for businesses that have not uploaded one — so the fallback has to be part of
 * the design rather than a broken-image box.
 */
export function CoverPlate({
  url,
  name,
  width,
  height,
  className = '',
}: {
  url: string | null;
  name: string;
  width: number;
  height: number;
  className?: string;
}) {
  if (!url) {
    return (
      <div
        className={`plate flex items-center justify-center border border-line bg-kashi-deep ${className}`}
        aria-hidden="true"
      >
        <Khatam className="text-paper/60" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`${name} — tile plate`}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      className={`plate border border-line object-cover ${className}`}
    />
  );
}
