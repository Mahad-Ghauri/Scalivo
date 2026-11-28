export function Initials({ name, className = 'h-12 w-12 text-[16px]' }: { name: string; className?: string }) {
  const letters = name
    .replace(/^Dr\.\s*/, '')
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#eeebff] font-semibold text-brand ${className}`}
    >
      {letters}
    </span>
  );
}
