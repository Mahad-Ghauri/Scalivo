'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AuthenticatedBusiness } from '@/lib/auth/user';
import { BusinessSwitcher } from './BusinessSwitcher';

const ROUTES = [
  { name: 'Overview', href: '' },
  { name: 'Calendar', href: '/calendar' },
  { name: 'Appointments', href: '/appointments' },
  { name: 'Customers', href: '/customers' },
  { name: 'Services', href: '/services' },
  { name: 'Staff', href: '/staff' },
  { name: 'Marketing', href: '/marketing' },
  { name: 'Analytics', href: '/analytics' },
  { name: 'Settings', href: '/settings' },
];

interface Props {
  businesses: AuthenticatedBusiness[];
  currentBusinessId: string;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ businesses, currentBusinessId, isOpenMobile, onCloseMobile }: Props) {
  const pathname = usePathname();
  const basePath = `/dashboard/${currentBusinessId}`;

  return (
    <>
      {/* Mobile overlay */}
      {isOpenMobile && (
        <div 
          className="fixed inset-0 z-40 bg-ink/20 lg:hidden" 
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 transform border-r border-rule bg-paper transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          isOpenMobile ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center px-4 border-b border-rule">
          <Link href="/" className="font-display text-xl font-semibold text-ink">
            Scalivo
          </Link>
        </div>

        <BusinessSwitcher businesses={businesses} currentBusinessId={currentBusinessId} />

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {ROUTES.map((route) => {
            const href = `${basePath}${route.href}`;
            const isActive = pathname === href || (route.href !== '' && pathname.startsWith(href));

            return (
              <Link
                key={route.name}
                href={href}
                onClick={onCloseMobile}
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  isActive 
                    ? 'bg-ink text-paper' 
                    : 'text-ink/70 hover:bg-stone-50 hover:text-ink'
                }`}
              >
                {route.name}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
