import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';
import { AddBusinessForm } from '@/components/dashboard/AddBusinessForm';

/**
 * Add a branch (3.7).
 *
 * A branch is a business of its own: its own WhatsApp number, staff, hours and
 * marketplace listing. That is not a shortcut — a WhatsApp number links to one
 * session, so a second location needs a second number regardless, and keeping
 * them as separate tenants means a customer never has to be asked "which
 * branch?" before they can book.
 *
 * Outside the [businessId] shell on purpose: this page belongs to the owner's
 * account, not to any one of their businesses.
 */
export const metadata = { title: 'Add a branch' };

export default async function AddBusinessPage() {
  const session = await getCurrentUser();
  if (!session) redirect('/login');

  const first = session.businesses[0];
  const back = first ? `/dashboard/${first.id}` : '/dashboard';

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-5 py-12">
      <div className="w-full max-w-[480px] rounded-3xl border border-line bg-white p-8 shadow-sm md:p-10">
        <Link href={back} className="text-[14px] font-medium text-muted underline-offset-4 hover:underline">
          ← Back to dashboard
        </Link>

        <div className="mb-8 mt-6">
          <h1 className="text-[32px] font-bold leading-none tracking-[-0.03em] text-ink">Add a branch</h1>
          <p className="mt-3 text-[15px] text-muted">
            Each branch gets its own WhatsApp number, staff and listing. You&apos;ll switch between them from the
            business menu.
          </p>
        </div>

        <AddBusinessForm defaultCategory={first?.category ?? 'salon'} />
      </div>
    </main>
  );
}
