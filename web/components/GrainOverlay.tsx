/**
 * The entire texture budget: one paper grain, rendered once, fixed, inert.
 * Everything else on the page is flat colour and hairlines.
 */
export function GrainOverlay() {
  return (
    <svg className="grain" aria-hidden="true" focusable="false">
      <filter id="paper-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves={3} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#paper-grain)" />
    </svg>
  );
}
