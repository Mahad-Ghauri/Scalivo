import { CustomerBookingTools } from '@/components/dashboard/CustomerBookingTools';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, fetchApi } from '@/lib/api-client';
import { formatPrice } from '@/lib/marketplace';
import { BOOKING_STATUS } from '@scalivo/shared';

interface ProfileView {
  clientId: string;
  businessId: string;
  displayName: string | null;
  phone: string | null;
  tags: string[];
  totalVisits: number;
  lifetimeSpendMinor: number;
  averageGapDays: number | null;
  lastVisitAt: string | null;
  nextExpectedVisitAt: string | null;
  mostBookedServiceId: string | null;
  preferredStaffId: string | null;
  notes: string;
  marketingOptOut: boolean;
  lastMarketingMessageAt: string | null;
  noShows: number;
  cancellations: number;
  hasUpcomingBooking: boolean;
}

interface HistoryBooking {
  id: string;
  startsAt: string;
  status: string;
  priceMinor: number;
  source: string;
  serviceName: string;
  staffName: string;
}

interface CrmDetailResponse {
  profile: ProfileView;
  history: HistoryBooking[];
}

function StatusBadge({ status }: { status: string }) {
  let bg = 'bg-surface text-muted';
  let label = 'Unknown';

  switch (status) {
    case BOOKING_STATUS.PENDING:
      bg = 'bg-brand/10 text-brand';
      label = 'Pending';
      break;
    case BOOKING_STATUS.AWAITING_APPROVAL:
      bg = 'bg-star/20 text-amber-900';
      label = 'Awaiting approval';
      break;
    case BOOKING_STATUS.AWAITING_DEPOSIT:
      bg = 'bg-star/20 text-amber-900';
      label = 'Awaiting Deposit';
      break;
    case BOOKING_STATUS.CONFIRMED:
      bg = 'bg-brand/10 text-brand';
      label = 'Confirmed';
      break;
    case BOOKING_STATUS.COMPLETED:
      bg = 'bg-open/10 text-open';
      label = 'Completed';
      break;
    case BOOKING_STATUS.NO_SHOW:
      bg = 'bg-surface text-muted line-through';
      label = 'No Show';
      break;
    case BOOKING_STATUS.CANCELLED:
      bg = 'bg-surface text-muted line-through';
      label = 'Cancelled';
      break;
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${bg}`}
    >
      {label}
    </span>
  );
}

interface BusinessResponse {
  timezone: string;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ businessId: string; clientId: string }>;
}) {
  const { businessId, clientId } = await params;

  let detail: CrmDetailResponse | null = null;
  let business: BusinessResponse | null = null;
  let holders: { id: string; name: string; active: boolean }[] = [];

  try {
    const [detailRes, businessRes, holdersRes] = await Promise.all([
      fetchApi<CrmDetailResponse>(`/businesses/${businessId}/clients/${clientId}`),
      fetchApi<BusinessResponse>(`/businesses/${businessId}`),
      fetchApi<{ holders: typeof holders }>(
        `/businesses/${businessId}/clients/${clientId}/holders`,
      ),
    ]);
    detail = detailRes;
    business = businessRes;
    holders = holdersRes.holders;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  if (!detail || !business) {
    notFound();
  }

  const { profile, history } = detail;
  const timezone = business.timezone;

  // The API sorts bookings by startsAt: -1 (newest first).
  // Find the most recent future booking that is active.
  const now = new Date();
  const upcomingBookings = history.filter(
    (b) =>
      new Date(b.startsAt) >= now &&
      b.status !== BOOKING_STATUS.CANCELLED &&
      b.status !== BOOKING_STATUS.NO_SHOW,
  );

  // Since history is startsAt: -1, the last item in upcomingBookings is the SOONEST future booking.
  const nextAppointment =
    upcomingBookings.length > 0 ? upcomingBookings[upcomingBookings.length - 1] : null;

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });

  const formatDateTime = (isoString: string) => {
    const d = new Date(isoString);
    return `${dateFormatter.format(d)} at ${timeFormatter.format(d)}`;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-8 py-6 border-b border-line bg-surface/30">
        <div className="mb-4">
          <Link
            href={`/dashboard/${businessId}/customers`}
            className="inline-flex items-center text-[13px] font-medium text-muted hover:text-ink transition-colors"
          >
            <svg className="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            Back to Customers
          </Link>
        </div>

        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
            {profile.displayName ?? 'Unknown Name'}
          </h1>
          {profile.phone && (
            <p className="mt-1 text-[15px] font-medium text-muted">{profile.phone}</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 px-8 py-8 overflow-y-auto space-y-8">
        {/* Summary Metrics */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
            <h3 className="text-[13px] font-medium uppercase tracking-wider text-muted">
              Total Visits
            </h3>
            <p className="mt-2 text-2xl font-bold text-ink">{profile.totalVisits}</p>
          </div>
          <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
            <h3 className="text-[13px] font-medium uppercase tracking-wider text-muted">
              Lifetime Spend
            </h3>
            <p className="mt-2 text-2xl font-bold text-ink">
              {formatPrice(profile.lifetimeSpendMinor)}
            </p>
          </div>
          <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
            <h3 className="text-[13px] font-medium uppercase tracking-wider text-muted">
              Last Visit
            </h3>
            <p className="mt-2 text-2xl font-bold text-ink">
              {profile.lastVisitAt ? dateFormatter.format(new Date(profile.lastVisitAt)) : '—'}
            </p>
          </div>
        </div>

        {/* Upcoming Appointment */}
        {nextAppointment && (
          <div>
            <h2 className="mb-4 text-lg font-semibold text-ink">Upcoming Appointment</h2>
            <div className="rounded-2xl border border-brand/20 bg-brand/5 p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <p className="text-[15px] font-semibold text-ink">
                    {formatDateTime(nextAppointment.startsAt)}
                  </p>
                  <p className="text-[14px] text-muted mt-0.5">
                    {nextAppointment.serviceName} with {nextAppointment.staffName}
                  </p>
                </div>
                <div>
                  <StatusBadge status={nextAppointment.status} />
                </div>
              </div>
            </div>
          </div>
        )}

        <CustomerBookingTools businessId={businessId} clientId={clientId} holders={holders} />

        {/* Booking History */}
        <div>
          <h2 className="mb-4 text-lg font-semibold text-ink">Visit History</h2>

          {history.length > 0 ? (
            <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
              <table className="w-full text-left text-[14px]">
                <thead>
                  <tr className="border-b border-line bg-surface/50 text-[12px] font-semibold uppercase tracking-wider text-muted">
                    <th className="px-6 py-4">Date</th>
                    <th className="px-6 py-4">Service & Staff</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4 text-right">Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.map((booking) => (
                    <tr key={booking.id} className="hover:bg-surface/50 transition-colors">
                      <td className="px-6 py-4 font-medium text-ink">
                        {formatDateTime(booking.startsAt)}
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-semibold text-ink">{booking.serviceName}</div>
                        <div className="text-[13px] text-muted mt-0.5">
                          with {booking.staffName}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={booking.status} />
                      </td>
                      <td className="px-6 py-4 text-right font-medium text-ink">
                        {formatPrice(booking.priceMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-2xl border border-line bg-white p-12 text-center shadow-sm">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface">
                <svg
                  className="h-6 w-6 text-muted"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-ink">No visit history yet</h3>
              <p className="mt-1 text-[14px] text-muted">
                Bookings will appear here once they are made.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
