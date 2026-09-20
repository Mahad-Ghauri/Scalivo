'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AuthenticatedUser, AuthenticatedBusiness } from '@/lib/auth/user';
import { BusinessSwitcher } from './BusinessSwitcher';
import { logoutAction } from '@/lib/actions/auth';

interface Props {
  user: AuthenticatedUser;
  businesses: AuthenticatedBusiness[];
  currentBusinessId: string;
  children: React.ReactNode;
}

const ROUTES = [
  { name: 'Overview', href: '' },
  { name: 'Calendar', href: '/calendar' },
  { name: 'Appointments', href: '/appointments' },
  { name: 'Customers', href: '/customers' },
  { name: 'Reviews', href: '/reviews' },
  { name: 'Services', href: '/services' },
  { name: 'Staff', href: '/staff' },
  { name: 'Marketing', href: '/marketing' },
  { name: 'Analytics', href: '/analytics' },
  { name: 'Settings', href: '/settings' },
];

export function DashboardShell({ user, businesses, currentBusinessId, children }: Props) {
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const pathname = usePathname();
  const basePath = `/dashboard/${currentBusinessId}`;

  return (
    <div className="flex h-screen flex-col bg-white overflow-hidden">
      <header className="shrink-0 border-b border-line bg-white z-40">
        <div className="mx-auto flex 
         flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3 md:px-8 md:py-3">
          <Link href="/" className="text-[26px] font-bold leading-none tracking-[-0.04em] text-ink shrink-0 mr-4">
            scalivo
          </Link>
          
          <div className="shrink-0 hidden md:block">
            <BusinessSwitcher businesses={businesses} currentBusinessId={currentBusinessId} />
          </div>

          <nav aria-label="Primary" className="ml-auto flex flex-1 items-center gap-2 overflow-x-auto no-scrollbar pb-1 md:pb-0 md:flex-none">
            {ROUTES.map((route) => {
              const href = `${basePath}${route.href}`;
              const isActive = pathname === href || (route.href !== '' && pathname.startsWith(href));

              return (
                <Link
                  key={route.name}
                  href={href}
                  className={`inline-flex h-10 items-center whitespace-nowrap rounded-full px-4 text-[15px] font-semibold transition-colors ${
                    isActive 
                      ? 'bg-ink text-white' 
                      : 'border border-transparent bg-white text-ink hover:bg-surface border-line'
                  }`}
                >
                  {route.name}
                </Link>
              );
            })}
          </nav>

          <div className="relative shrink-0 ml-2">
            <button
              onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              className="flex items-center gap-2 rounded-full border border-line bg-white p-1 pr-3 hover:bg-surface transition-colors"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-ink text-[14px] font-bold">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <svg className="w-4 h-4 text-ink" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isUserMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsUserMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-64 rounded-2xl border border-line bg-white shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-4 border-b border-line bg-surface/50">
                    <p className="text-[16px] font-bold text-ink truncate">{user.name}</p>
                    <p className="text-[14px] font-medium text-muted truncate">{user.email}</p>
                  </div>
                  
                  <div className="p-2 md:hidden">
                    <p className="px-3 pb-1 pt-2 text-[12px] font-bold uppercase tracking-wider text-muted">Switch Business</p>
                    <div className="px-1">
                      <BusinessSwitcher businesses={businesses} currentBusinessId={currentBusinessId} />
                    </div>
                  </div>

                  <form action={logoutAction} className="w-full p-2 border-t border-line md:border-t-0">
                    <button
                      type="submit"
                      className="w-full text-left rounded-xl px-4 py-3 text-[15px] font-semibold text-red-600 hover:bg-red-50 transition-colors"
                    >
                      Sign out
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] px-5 py-6 md:px-8 h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
