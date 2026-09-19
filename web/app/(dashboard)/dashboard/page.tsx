import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';

export default async function DashboardIndexPage() {
  const session = await getCurrentUser();

  // layout.tsx already guarantees session exists, but TypeScript needs it checked.
  if (!session) {
    redirect('/login');
  }

  // Redirect to the first business if they have any, otherwise show empty state
  const firstBusiness = session.businesses[0];
  if (firstBusiness) {
    redirect(`/dashboard/${firstBusiness.id}`);
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-display font-semibold text-ink">Welcome to Scalivo</h1>
        <p className="mt-2 text-muted">You do not currently have access to any businesses.</p>
      </div>
    </div>
  );
}
