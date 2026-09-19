import { ReactNode } from 'react';

interface Props {
  title: string;
  value: string | number;
  icon?: ReactNode;
  description?: string;
}

export function StatCard({ title, value, icon, description }: Props) {
  return (
    <div className="rounded-xl border border-line bg-white p-6 shadow-sm flex flex-col">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted">{title}</h3>
        {icon && <div className="text-muted/70">{icon}</div>}
      </div>
      <div className="mt-4 flex flex-col gap-1">
        <p className="text-3xl font-display font-semibold text-ink">{value}</p>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
    </div>
  );
}
