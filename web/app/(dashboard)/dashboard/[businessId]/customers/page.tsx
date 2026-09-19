export default function DashboardCustomersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold text-ink capitalize">customers</h1>
        <p className="mt-1 text-sm text-muted">Manage your customers here.</p>
      </div>

      <div className="rounded-lg border border-rule bg-white p-12 text-center">
        <h2 className="text-lg font-medium text-ink">Customers coming soon</h2>
        <p className="mt-2 text-sm text-muted">
          This feature will be implemented in a future phase.
        </p>
      </div>
    </div>
  );
}