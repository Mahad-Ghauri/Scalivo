import Link from 'next/link';
import { ClientImport } from '@/components/dashboard/ClientImport';

export default async function ImportCustomersPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  return (
    <div className="space-y-6 py-2">
      <div>
        <Link
          href={`/dashboard/${businessId}/customers`}
          className="text-[14px] font-medium text-muted hover:text-ink"
        >
          ← Customers
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink lowercase font-display">
          import customers
        </h1>
        <p className="mt-1 max-w-2xl text-[15px] text-muted">
          Bring in the customers you already have, from a spreadsheet or a phone contacts export
          saved as CSV. Their history means Scalivo knows who your regulars are from the first day.
        </p>
      </div>

      <ClientImport businessId={businessId} />
    </div>
  );
}
