import { formatPrice } from '@/lib/marketplace';
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

interface Props {
  clients: CrmClient[];
  businessId: string;
}

function TagBadge({ tag }: { tag: ClientTag }) {
  let bg = 'bg-surface text-ink';
  let label = tag.replace('_', ' ');

  switch (tag) {
    case 'new':
      bg = 'bg-open/10 text-open';
      label = 'New';
      break;
    case 'vip':
      bg = 'bg-brand/10 text-brand';
      label = 'VIP';
      break;
    case 'at_risk':
      bg = 'bg-star/20 text-amber-900';
      label = 'At Risk';
      break;
    case 'lapsed':
      bg = 'bg-surface text-muted';
      label = 'Lapsed';
      break;
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold tracking-wide uppercase ${bg}`}>
      {label}
    </span>
  );
}

export function CustomerList({ clients }: Props) {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
      <table className="w-full text-left text-[14px]">
        <thead>
          <tr className="border-b border-line bg-surface/50 text-[12px] font-semibold uppercase tracking-wider text-muted">
            <th className="px-6 py-4">Customer</th>
            <th className="px-6 py-4">Status</th>
            <th className="px-6 py-4 text-right">Visits</th>
            <th className="px-6 py-4 text-right">Total Spend</th>
            <th className="px-6 py-4 text-right">Last Visit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {clients.map((client) => {
            const lastVisit = client.lastVisitAt ? new Date(client.lastVisitAt) : null;
            
            return (
              <tr key={client.id} className="hover:bg-surface/50 transition-colors">
                <td className="px-6 py-4">
                  <div className="font-semibold text-ink">
                    {client.displayName ?? 'Unknown Name'}
                  </div>
                  {client.phone && (
                    <div className="text-[13px] text-muted mt-0.5 font-medium">
                      {client.phone}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-1.5">
                    {client.tags.length > 0 ? (
                      client.tags.map(tag => <TagBadge key={tag} tag={tag} />)
                    ) : (
                      <span className="text-muted text-[13px]">—</span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 text-right font-medium text-ink">
                  {client.totalVisits}
                </td>
                <td className="px-6 py-4 text-right font-medium text-ink">
                  {formatPrice(client.lifetimeSpendMinor)}
                </td>
                <td className="px-6 py-4 text-right">
                  {lastVisit ? (
                    <span className="text-ink font-medium">{dateFormatter.format(lastVisit)}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
