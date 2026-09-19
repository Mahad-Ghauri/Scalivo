import Link from 'next/link';

/** Deliberately transition-free: an active filter is a switch, not an animation. */
export function FilterChip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number | undefined;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`label inline-flex items-center gap-1.5 rounded-chip border px-2.5 py-1.5 ${
        active
          ? 'border-kashi bg-kashi text-paper'
          : 'border-line bg-raised text-ink hover:border-kashi hover:text-kashi'
      }`}
    >
      {label}
      {count === undefined ? null : (
        <span className={`num text-[0.625rem] ${active ? 'text-paper/70' : 'text-muted'}`}>{count}</span>
      )}
    </Link>
  );
}
