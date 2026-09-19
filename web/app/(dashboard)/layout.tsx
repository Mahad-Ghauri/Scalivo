import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';

export default async function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentUser();

  // Route group root layout guarantees all /dashboard routes are authenticated
  if (!session) {
    redirect('/login');
  }

  return <>{children}</>;
}
