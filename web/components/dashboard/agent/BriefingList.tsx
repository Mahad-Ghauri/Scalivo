import type { Briefing } from '@scalivo/shared';
import { BriefingCard } from './BriefingCard';

/**
 * The archive of what the agent has said — SPEC §11.
 *
 * A plain list, and a server component: the cards are the interactive part, and
 * making the list a client component too would ship the whole feed to the browser
 * for nothing.
 */
export function BriefingList({
  businessId,
  briefings,
  timezone,
}: {
  businessId: string;
  briefings: Briefing[];
  timezone: string;
}) {
  if (briefings.length === 0) {
    return (
      <p className="text-[15px] text-muted">
        Nothing yet. The first summary arrives tomorrow morning.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {briefings.map((briefing) => (
        <li key={briefing.id}>
          <BriefingCard businessId={businessId} briefing={briefing} timezone={timezone} />
        </li>
      ))}
    </ul>
  );
}
