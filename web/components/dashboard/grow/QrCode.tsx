import qrcode from 'qrcode-generator';

/**
 * A QR code as inline SVG — crisp at any print size, and rendered on the server
 * so the poster needs no script to show it.
 *
 * Error correction 'M' (15%): enough to survive a scuffed, sun-faded poster on a
 * counter, without the density of 'H' that makes a long wa.me link hard to scan
 * from arm's length. The four-module quiet zone is part of the spec, not
 * padding — scanners fail on a code printed flush against other ink.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const qr = qrcode(0, 'M');
  // Every value here is a URL, already percent-encoded to ASCII.
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;

  // One path, runs of dark modules merged per row: a few hundred segments
  // rather than a few thousand <rect>s.
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      let run = 1;
      while (col + run < count && qr.isDark(row, col + run)) run++;
      d += `M${col + quiet} ${row + quiet}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0d0d0d" />
    </svg>
  );
}
