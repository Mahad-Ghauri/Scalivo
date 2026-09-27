import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { BriefingFeed } from '@scalivo/shared';
import { getCurrentUser } from '@/lib/auth/user';
import { fetchApi } from '@/lib/api-client';
import { BriefingList } from '@/components/dashboard/agent/BriefingList';
import { AgentSettings } from '@/components/dashboard/agent/AgentSettings';

/**
 * What the agent has said — SPEC §11.
 *
 * The agent's promise is that there is nothing to open, so this page is not where
 * the feature happens: the notification is. This is the archive behind it, which a
 * push notification cannot be, and the one screen where the owner can turn the
 * whole thing off.
 *
 * It is reached from the Overview card and from tapping a notification, and it is
 * deliberately NOT in the primary navigation. A nav item would imply a place the
 * owner is meant to visit, which is the opposite of what this subsystem is for.
 */
export default async function BriefingsPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getCurrentUser();
  const business = session?.businesses.find((b) => b.id === businessId);
  if (!business) notFound();

  const feed = await fetchApi<BriefingFeed>(
    `/businesses/${businessId}/agent/briefings`,
  ).catch(() => null);

  if (!feed) {
    return (
      <p className="py-12 text-center text-muted">
        Could not load your summaries. Please try refreshing.
      </p>
    );
  }

  return (
    <div className="space-y-6 py-2">
      <div>
        <Link
          href={`/dashboard/${businessId}`}
          className="text-[14px] font-semibold text-brand hover:underline"
        >
          ← Overview
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink lowercase font-display">
          what scalivo told you
        </h1>
        <p className="mt-1 text-[15px] text-muted">
          Every morning, every Monday, and whenever something is worth your attention.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <h2 className="text-[17px] font-semibold text-ink">Summaries on your phone</h2>
        <div className="mt-3">
          <AgentSettings businessId={businessId} settings={feed.settings} />
        </div>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px] font-semibold text-ink">Everything so far</h2>
          {feed.unread > 0 && (
            <p className="text-[14px] text-muted">
              {feed.unread} you have not read yet
            </p>
          )}
        </div>
        <BriefingList
          businessId={businessId}
          briefings={feed.briefings}
          timezone={business.timezone}
        />
      </section>
    </div>
  );
}
