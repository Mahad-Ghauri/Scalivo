export default function DashboardAppointmentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold text-ink capitalize">appointments</h1>
        <p className="mt-1 text-sm text-muted">Manage your appointments here.</p>
      </div>

      <div className="rounded-lg border border-line bg-white p-12 text-center">
        <h2 className="text-lg font-medium text-ink">Appointments coming soon</h2>
        <p className="mt-2 text-sm text-muted">
          This feature will be implemented in a future phase.
        </p>
      </div>
    </div>
  );
}