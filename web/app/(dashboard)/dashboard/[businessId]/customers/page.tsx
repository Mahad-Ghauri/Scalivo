import { fetchApi } from '@/lib/api-client';
import { CustomerList } from '@/components/dashboard/CustomerList';
import { SearchInput } from '@/components/dashboard/SearchInput';
import { Pagination } from '@/components/dashboard/Pagination';
import type { ClientTag } from '@scalivo/shared';

interface CrmClient {
  id: string;
  clientId: string;
  displayName: string | null;
  phone: string | null;
  tags: ClientTag[];
  totalVisits: number;
  lifetimeSpendMinor: number;
  lastVisitAt: string | null;
  nextExpectedVisitAt: string | null;
  averageGapDays: number | null;
  marketingOptOut: boolean;
}

interface CrmResponse {
  clients: CrmClient[];
  total: number;
  filteredWithinPage?: boolean;
}

export default async function DashboardCustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { q, page: pageParam } = await searchParams;

  const searchQuery = typeof q === 'string' ? q : '';
  const page = typeof pageParam === 'string' ? parseInt(pageParam, 10) : 1;
  const validPage = isNaN(page) || page < 1 ? 1 : page;
  const pageSize = 50;
  const skip = (validPage - 1) * pageSize;

  let response: CrmResponse = { clients: [], total: 0 };
  let error = false;

  try {
    response = await fetchApi<CrmResponse>(`/businesses/${businessId}/clients`, {
      params: {
        limit: pageSize.toString(),
        skip: skip.toString(),
        ...(searchQuery ? { q: searchQuery } : {}),
      },
    });
  } catch {
    error = true;
  }

  const { clients, total } = response;
  const isEmpty = total === 0 && !searchQuery;
  const isNoResults = total === 0 && searchQuery;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-8 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">
              customers
            </h1>
            <p className="mt-1 text-[15px] text-muted">
              Manage and search your client directory.
            </p>
          </div>
        </div>

        {!isEmpty && !error && (
          <div className="mt-6 flex items-center justify-between">
            <SearchInput placeholder="Search by name or phone..." defaultValue={searchQuery} />
            <div className="text-[14px] text-muted font-medium">
              {total} {total === 1 ? 'customer' : 'customers'}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 px-8 pb-8 overflow-y-auto">
        {error ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-red-900">Failed to load customers</h2>
            <p className="mt-2 text-sm text-red-700 font-medium">
              We encountered an issue fetching your customer list. Please try refreshing.
            </p>
          </div>
        ) : isEmpty ? (
          <div className="rounded-2xl border border-line bg-white p-16 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface">
              <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold text-ink">No customers yet</h2>
            <p className="mt-2 text-[15px] text-muted font-medium">
              Your customers will appear here automatically after their first booking.
            </p>
          </div>
        ) : isNoResults ? (
          <div className="rounded-2xl border border-line bg-white p-16 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface">
              <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold text-ink">No results found</h2>
            <p className="mt-2 text-[15px] text-muted font-medium">
              No customers match your search for "{searchQuery}".
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <CustomerList clients={clients} businessId={businessId} />
            <Pagination total={total} pageSize={pageSize} currentPage={validPage} />
          </div>
        )}
      </div>
    </div>
  );
}