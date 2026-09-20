import type { VolumeBreakdown } from '@scalivo/shared';

/**
 * What became of the appointments in the range.
 *
 * Status colours, not series colours: they mean a state, they are reserved for
 * these four, and every one of them ships with its label and its count. Nothing
 * here is carried by hue alone — the bar is a summary of the list beneath it,
 * and the list is the real answer.
 */

const STATES = [
  { key: 'completed', label: 'Completed', color: '#00875a' },
  { key: 'upcoming', label: 'Still to come', color: '#737373' },
  { key: 'cancelled', label: 'Cancelled', color: '#ec835a' },
  { key: 'noShow', label: 'No-show', color: '#d03b3b' },
] as const satisfies readonly { key: keyof VolumeBreakdown; label: string; color: string }[];

export function StatusBreakdown({ volume }: { volume: VolumeBreakdown }) {
  const total = volume.total;

  return (
    <figure className="rounded-xl border border-line bg-white p-6 shadow-sm">
      <figcaption className="text-sm font-medium text-muted">
        {total === 0 ? 'Appointments' : `${total} appointment${total === 1 ? '' : 's'}`}
      </figcaption>

      {total === 0 ? (
        <p className="mt-6 text-[15px] text-muted">Nothing in this range yet.</p>
      ) : (
        <>
          {/* 2px of surface between segments — the gap separates them, not a stroke. */}
          <div className="mt-5 flex h-3 gap-[2px] overflow-hidden" aria-hidden="true">
            {STATES.filter((state) => volume[state.key] > 0).map((state) => (
              <div
                key={state.key}
                className="h-full rounded-[2px]"
                style={{
                  width: `${(volume[state.key] / total) * 100}%`,
                  background: state.color,
                }}
              />
            ))}
          </div>

          <ul className="mt-5 space-y-2.5">
            {STATES.map((state) => (
              <li key={state.key} className="flex items-baseline gap-2.5 text-[14px]">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-full"
                  style={{ background: state.color }}
                />
                <span className="text-ink">{state.label}</span>
                <span className="ml-auto tabular-nums font-medium text-ink">
                  {volume[state.key]}
                </span>
                <span className="w-12 text-right tabular-nums text-muted">
                  {Math.round((volume[state.key] / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}
