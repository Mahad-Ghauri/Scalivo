import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';
import { fetchApi } from '@/lib/api-client';
import { type BriefingFeed, type CalendarView, BOOKING_STATUS } from '@scalivo/shared';
import { StatCard } from '@/components/dashboard/StatCard';
import { AppointmentList } from '@/components/dashboard/AppointmentList';
import { BriefingCard } from '@/components/dashboard/agent/BriefingCard';
import { formatPrice } from '@/lib/marketplace';

interface Props {
  params: Promise<{ businessId: string }>;
}

export default async function DashboardOverviewPage({ params }: Props) {
  const session = await getCurrentUser();
  if (!session) {
    redirect('/login');
  }

  const { businessId } = await params;
  const business = session.businesses.find((b) => b.id === businessId);
  if (!business) {
    // Layout already catches this and throws notFound, but this is for type safety.
    return null;
  }

  const timezone = business.timezone;
  const now = new Date();

  // Create native formatters for the business timezone
  // This avoids adding a heavyweight luxon dependency to the frontend just for YYYY-MM-DD.
  // en-CA natively formats as YYYY-MM-DD.
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const todayStr = dateFormatter.format(now);
  
  // Widen the calendar fetch to a 7-day window.
  // This gives the "Upcoming Appointments" section a reasonable runway to filter from
  // beyond just today, preventing a false "empty state" when bookings exist later this week.
  const endWindowDate = new Date(now.getTime() + 7 * 86400000);
  const endWindowStr = dateFormatter.format(endWindowDate);

  // Parallel fetch pattern (BFF orchestration)
  // Calendar returns a grouped view bounded by the requested local dates.
  // Clients query fetches only the count (limit=1) to avoid loading the whole collection.
  const [calendarView, clientsData, feed] = await Promise.all([
    fetchApi<CalendarView>(`/businesses/${businessId}/calendar?from=${todayStr}&to=${endWindowStr}`),
    fetchApi<{ total: number }>(`/businesses/${businessId}/clients?limit=1`),
    // The agent's latest (SPEC §11). Caught rather than awaited strictly: a
    // summary is the least important thing on this page and must never be the
    // reason the diary fails to load.
    fetchApi<BriefingFeed>(`/businesses/${businessId}/agent/briefings?limit=1`).catch(() => null),
  ]);

  if (!calendarView || !clientsData) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
        <p className="font-medium">Failed to load dashboard data</p>
        <p className="text-sm mt-1">There was a problem communicating with the backend. Please try again.</p>
      </div>
    );
  }

  // Find the day bucket for 'today'
  const todayBucket = calendarView.days.find((d) => d.date === todayStr);
  const todayEntries = todayBucket?.entries ?? [];

  // 1. Calculate Today's Appointments Count
  const todayCount = todayEntries.length;

  // 2. Calculate Today's Booked Value
  // Sum priceMinor for bookings that are not cancelled or no_show.
  const bookedValueMinor = todayEntries
    .filter((e) => e.status !== BOOKING_STATUS.CANCELLED && e.status !== BOOKING_STATUS.NO_SHOW)
    .reduce((sum, e) => sum + e.priceMinor, 0);

  // 3. Find Upcoming Appointments
  // "Upcoming" means startsAt > now (where 'now' is the absolute instant).
  // We use all returned entries (the 7-day window), filter by startsAt > now, 
  // sort ascending, and strictly slice to 5 items.
  const allEntries = calendarView.days.flatMap((d) => d.entries);
  
  // Create a Map to deduplicate, because an appointment spanning midnight 
  // appears in BOTH days in the backend CalendarView.
  const uniqueEntries = Array.from(new Map(allEntries.map(e => [e.id, e])).values());

  const upcomingEntries = uniqueEntries
    .filter((e) => new Date(e.startsAt).getTime() > now.getTime())
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    .slice(0, 5);

  const latest = feed?.briefings[0] ?? null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-display font-semibold text-ink">Overview</h1>
        <p className="mt-1 text-sm text-muted">
          Welcome to your {business.name} dashboard.
        </p>
      </div>

      {/*
        The agent's latest, above the numbers (SPEC §11).

        First on the page because it is the only thing here that has already done
        the reading for the owner — the stat cards below tell them what happened,
        this tells them what it means and what to do about it. It is also how an
        owner who never taps a notification still meets the feature.
      */}
      {latest && (
        <section>
          <BriefingCard businessId={businessId} briefing={latest} timezone={timezone} />
          <Link
            href={`/dashboard/${businessId}/briefings`}
            className="mt-2 inline-block text-[14px] font-semibold text-brand hover:underline"
          >
            Everything Scalivo has told you
            {feed && feed.unread > 1 ? ` · ${feed.unread} unread` : ''}
          </Link>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard 
          title="Today's Appointments" 
          value={todayCount} 
        />
        <StatCard 
          title="Booked Value" 
          value={formatPrice(bookedValueMinor)} 
          description="Service value of today's valid bookings"
        />
        <StatCard 
          title="Total Customers" 
          value={clientsData.total} 
        />
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-4">
            <h2 className="text-lg font-medium text-ink">Today&apos;s Schedule</h2>
            <p className="text-sm text-muted">All appointments scheduled for today.</p>
          </div>
          <AppointmentList 
            entries={todayEntries} 
            timezone={timezone} 
            emptyMessage="No appointments scheduled for today." 
          />
        </section>

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-medium text-ink">Upcoming</h2>
            <p className="text-sm text-muted">Your next 5 upcoming appointments.</p>
          </div>
          <AppointmentList 
            entries={upcomingEntries} 
            timezone={timezone} 
            emptyMessage="No upcoming appointments." 
          />
        </section>
      </div>
    </div>
  );
}
