'use client';

import { useState } from 'react';
import type { AuthenticatedUser, AuthenticatedBusiness } from '@/lib/auth/user';
import { Sidebar } from './Sidebar';
import { logoutAction } from '@/lib/actions/auth';

interface Props {
  user: AuthenticatedUser;
  businesses: AuthenticatedBusiness[];
  currentBusinessId: string;
  children: React.ReactNode;
}

export function DashboardShell({ user, businesses, currentBusinessId, children }: Props) {
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  return (
    <div className="flex h-screen bg-stone-50">
      <Sidebar 
        businesses={businesses} 
        currentBusinessId={currentBusinessId} 
        isOpenMobile={isOpenMobile} 
        onCloseMobile={() => setIsOpenMobile(false)} 
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-rule bg-paper px-4 lg:justify-end">
          <button
            onClick={() => setIsOpenMobile(true)}
            className="lg:hidden p-2 -ml-2 text-ink/70 hover:text-ink"
            aria-label="Open sidebar"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="relative">
            <button
              onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              className="flex items-center gap-2 text-sm font-medium text-ink/80 hover:text-ink"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-200 text-ink">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <span className="hidden sm:block">{user.name}</span>
            </button>

            {isUserMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsUserMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-48 rounded-md border border-rule bg-paper shadow-lg z-50">
                  <div className="px-4 py-3 border-b border-rule">
                    <p className="text-sm font-medium text-ink truncate">{user.name}</p>
                    <p className="text-xs text-muted truncate">{user.email}</p>
                  </div>
                  <form action={logoutAction} className="w-full">
                    <button
                      type="submit"
                      className="w-full text-left px-4 py-2 text-sm text-signal-deep hover:bg-stone-50 transition-colors"
                    >
                      Sign out
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
