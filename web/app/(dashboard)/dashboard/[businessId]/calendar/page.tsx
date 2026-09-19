import { notFound } from 'next/navigation';
import { fetchApi } from '@/lib/api-client';
import type { CalendarView, CalendarEntry, Service, Staff, Client } from '@scalivo/shared';
import { CalendarGrid } from '@/components/dashboard/CalendarGrid';
import { CalendarControls } from '@/components/dashboard/CalendarControls';
import { CalendarDetailPanel } from '@/components/dashboard/CalendarDetailPanel';
import { addDays, getWeekStart } from '@/lib/calendar-utils';

interface PageProps {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function CalendarPage({ params, searchParams }: PageProps) {
  const { businessId } = await params;
  const resolvedSearchParams = await searchParams;

  // Derive today's date in the business's timezone.
  // We need to fetch the business's timezone first if we were being strictly accurate,
  // but to avoid a separate round trip just to get the timezone, we can use the server's
  // current date as a fallback if `date` param is missing. For a robust implementation,
  // the `date` should ideally be present in the URL, or we fetch the timezone from the session.
  // However, `Intl.DateTimeFormat` without a timezone defaults to server time.
  // Let's rely on the session if we can, but since session isn't easily accessible here without
  // duplicate logic, we'll just use a basic string representation. Actually, the dashboard overview
  // had the same problem. Let's just use `new Date().toISOString().split('T')[0]` as a fallback today,
  // which might be 1 day off depending on timezone, but immediately resolves once the user clicks "Today".
  const fallbackToday = new Date().toISOString().split('T')[0] as string;

  const dateParam: string = typeof resolvedSearchParams.date === 'string' ? resolvedSearchParams.date : fallbackToday;
  const viewParam: string = typeof resolvedSearchParams.view === 'string' ? resolvedSearchParams.view : 'week';
  const eventId: string | undefined = typeof resolvedSearchParams.eventId === 'string' ? resolvedSearchParams.eventId : undefined;
  const showCancelledParam: boolean = resolvedSearchParams.showCancelled === 'true';

  const isWeekView = viewParam === 'week';

  // Calculate `from` and `to` based on the requested view
  const from: string = isWeekView ? getWeekStart(dateParam) : dateParam;
  const to: string = isWeekView ? addDays(from, 6) : from;

  // Fetch calendar data
  let calendarView: CalendarView;
  let services: Service[] = [];
  let staff: Staff[] = [];
  let clients: Client[] = [];
  try {
    const [calRes, svcRes, staffRes, clientsRes] = await Promise.all([
      fetchApi<CalendarView>(`/businesses/${businessId}/calendar?from=${from}&to=${to}${showCancelledParam ? '&includeCancelled=true' : ''}`),
      fetchApi<{ services: Service[] }>(`/businesses/${businessId}/services`),
      fetchApi<{ staff: Staff[] }>(`/businesses/${businessId}/staff`),
      fetchApi<{ clients: Client[] }>(`/businesses/${businessId}/clients`)
    ]);
    
    calendarView = calRes;
    services = svcRes.services;
    staff = staffRes.staff;
    clients = clientsRes.clients;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && (error.status === 404 || error.status === 403)) {
      notFound(); // Tenant isolation failure maps to 404
    }
    throw error;
  }

  // Calculate navigation dates
  const prevDate = isWeekView ? addDays(from, -7) : addDays(from, -1);
  const nextDate = isWeekView ? addDays(from, 7) : addDays(from, 1);
  
  // Actually, we do have the correct timezone in `calendarView.timezone`.
  // We can safely derive the REAL today date now that we have the timezone.
  const now = new Date();
  const realToday = new Intl.DateTimeFormat('en-CA', { timeZone: calendarView.timezone }).format(now);

  // If a specific event is selected, find it
  let selectedEntry: CalendarEntry | undefined;
  if (eventId) {
    for (const day of calendarView.days) {
      const found = day.entries.find((e) => e.id === eventId);
      if (found) {
        selectedEntry = found;
        break;
      }
    }
  }

  // Formatting title
  let title = '';
  if (isWeekView) {
    const fromDate = new Date(`${from}T12:00:00Z`);
    const toDate = new Date(`${to}T12:00:00Z`);
    const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short' });
    const dayFmt = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
    const yearFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric' });
    
    if (fromDate.getMonth() === toDate.getMonth()) {
      title = `${monthFmt.format(fromDate)} ${dayFmt.format(fromDate)} - ${dayFmt.format(toDate)}, ${yearFmt.format(fromDate)}`;
    } else if (fromDate.getFullYear() === toDate.getFullYear()) {
      title = `${monthFmt.format(fromDate)} ${dayFmt.format(fromDate)} - ${monthFmt.format(toDate)} ${dayFmt.format(toDate)}, ${yearFmt.format(fromDate)}`;
    } else {
      title = `${monthFmt.format(fromDate)} ${dayFmt.format(fromDate)}, ${yearFmt.format(fromDate)} - ${monthFmt.format(toDate)} ${dayFmt.format(toDate)}, ${yearFmt.format(toDate)}`;
    }
  } else {
    const titleFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    title = titleFormatter.format(new Date(`${from}T12:00:00Z`));
  }

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      <CalendarControls
        businessId={businessId}
        view={isWeekView ? 'week' : 'day'}
        currentDate={dateParam}
        todayDate={realToday}
        prevDate={prevDate}
        nextDate={nextDate}
        title={title}
        showCancelled={showCancelledParam}
        services={services}
        staff={staff}
        clients={clients}
      />
      
      <div className="flex gap-6 flex-1 min-h-0">
        <div className="flex-1 min-w-0">
          <CalendarGrid 
            businessId={businessId}
            viewData={calendarView}
            selectedEventId={eventId}
            view={isWeekView ? 'week' : 'day'}
          />
        </div>
        
        {selectedEntry && (
          <CalendarDetailPanel 
            businessId={businessId}
            entry={selectedEntry}
            dateStr={dateParam}
            view={isWeekView ? 'week' : 'day'}
            timezone={calendarView.timezone}
            services={services}
            staff={staff}
          />
        )}
      </div>
    </div>
  );
}