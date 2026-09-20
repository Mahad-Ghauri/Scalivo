import type { Granularity, RevenuePoint } from '@scalivo/shared';
import { formatPrice } from '@/lib/format';

/**
 * Revenue over time — one series, so no legend: the heading says what is plotted.
 *
 * Built from divs rather than a charting library. The whole chart is a row of
 * columns against three gridlines, and a dependency that ships a renderer, an
 * axis engine and a tooltip system to draw that is a dependency doing less than
 * the 80 lines below.
 *
 * Only the best bucket carries a value label. A number on every column is the
 * fastest way to make a chart that nobody reads — the axis and the table below
 * carry the rest.
 */

/** Columns stay thin; the leftover width in each band is deliberate air. */
const MAX_BAR_WIDTH = 24;

/** Round the top of the scale up to something a person would say out loud. */
function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function label(period: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [year, month] = period.split('-');
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-GB', {
      month: 'short',
    });
  }
  if (granularity === 'week') return period.split('-')[1] ?? period;

  const [, , day] = period.split('-');
  return day ?? period;
}

/** The label under the axis, spelled out — a tooltip should never be the only copy. */
function longLabel(period: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [year, month] = period.split('-');
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
    });
  }
  if (granularity === 'week') return `Week ${period.split('-W')[1]}, ${period.split('-')[0]}`;

  return new Date(`${period}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function RevenueChart({
  series,
  granularity,
}: {
  series: RevenuePoint[];
  granularity: Granularity;
}) {
  const peak = Math.max(...series.map((point) => point.revenueMinor), 0);
  const ceiling = niceCeiling(peak);
  const best = series.find((point) => point.revenueMinor === peak && peak > 0);

  // Ticks, not a gridline per bucket: the grid is there to be read past.
  const ticks = ceiling === 0 ? [0] : [ceiling, ceiling / 2, 0];

  // Every third label on a long range, so the axis never turns into a smear.
  const labelEvery = series.length > 16 ? Math.ceil(series.length / 12) : 1;

  return (
    <figure className="rounded-xl border border-line bg-white p-6 shadow-sm">
      <figcaption className="text-sm font-medium text-muted">Revenue from completed appointments</figcaption>

      <div className="mt-6 flex gap-3">
        <div
          className="flex w-16 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-muted"
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <span key={tick}>{formatPrice(tick)}</span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Hairline, solid, one step off the surface — there to be read past. */}
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            {ticks.map((tick) => (
              <div key={tick} className="h-px w-full bg-line" />
            ))}
          </div>

          <ol className="relative flex h-40 items-end gap-[2px]">
            {series.map((point) => {
              const height = ceiling === 0 ? 0 : (point.revenueMinor / ceiling) * 100;
              return (
                <li
                  key={point.period}
                  className="flex h-full flex-1 items-end justify-center"
                  style={{ maxWidth: series.length < 8 ? `${MAX_BAR_WIDTH * 2}px` : undefined }}
                >
                  <div
                    // The native tooltip is the hover layer: a real one here
                    // would mean making the whole page a client component to
                    // show what the table below already states.
                    title={`${longLabel(point.period, granularity)} — ${formatPrice(point.revenueMinor)}`}
                    style={{ height: `${height}%`, maxWidth: `${MAX_BAR_WIDTH}px` }}
                    className="w-full rounded-t bg-brand"
                  />
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="mt-2 flex gap-3">
        <div className="w-16 shrink-0" />
        <ol className="flex min-w-0 flex-1 gap-[2px]" aria-hidden="true">
          {series.map((point, index) => (
            <li
              key={point.period}
              className="flex-1 truncate text-center text-[11px] tabular-nums text-muted"
              style={{ maxWidth: series.length < 8 ? `${MAX_BAR_WIDTH * 2}px` : undefined }}
            >
              {index % labelEvery === 0 ? label(point.period, granularity) : ''}
            </li>
          ))}
        </ol>
      </div>

      {best && (
        <p className="mt-4 text-[13px] text-muted">
          Best {granularity}: <span className="font-medium text-ink">{longLabel(best.period, granularity)}</span>{' '}
          at {formatPrice(best.revenueMinor)}
        </p>
      )}

      {/*
        The chart is a picture of this. Screen readers, anyone who wants the
        exact numbers, and anyone printing the page get the table instead of a
        row of unlabelled rectangles.
      */}
      <details className="mt-4">
        <summary className="cursor-pointer text-[13px] font-medium text-muted hover:text-ink">
          Show the numbers
        </summary>
        <table className="mt-3 w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-muted">
              <th scope="col" className="py-1.5 font-medium">Period</th>
              <th scope="col" className="py-1.5 text-right font-medium">Completed</th>
              <th scope="col" className="py-1.5 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.period} className="border-b border-line/60">
                <td className="py-1.5 text-ink">{longLabel(point.period, granularity)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted">{point.completed}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">
                  {formatPrice(point.revenueMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
