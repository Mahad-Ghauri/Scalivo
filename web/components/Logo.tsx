/**
 * The Scalivo mark beside the wordmark — one component, so the site header, the
 * footer and the dashboard can never drift into three different logos.
 *
 * The mark is decorative (`alt=""`): the word next to it already says Scalivo,
 * and a screen reader announcing "Scalivo Scalivo" helps nobody.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <img src="/brand/scalivo-logo.svg" alt="" width={size} height={size} className="shrink-0" />
      scalivo
    </span>
  );
}
