import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ businessId: string }>;
}

export default async function BusinessDashboardLayout({ children, params }: LayoutProps) {
  const session = await getCurrentUser();
  const { businessId } = await params;

  if (!session) {
    redirect('/login');
  }

  // Authoritative frontend check: Does this user have access to this businessId?
  // Prevents enumeration of businesses they don't own by returning 404.
  const hasAccess = session.businesses.some((b) => b.id === businessId);
  if (!hasAccess) {
    notFound();
  }

  return (
    <DashboardShell user={session.user} businesses={session.businesses} currentBusinessId={businessId}>
      {children}
    </DashboardShell>
  );
}
