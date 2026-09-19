'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AuthenticatedBusiness } from '@/lib/auth/user';

interface Props {
  businesses: AuthenticatedBusiness[];
  currentBusinessId?: string;
}

export function BusinessSwitcher({ businesses, currentBusinessId }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  if (businesses.length === 0) {
    return <div className="text-sm font-medium text-ink px-4 py-2">No Businesses</div>;
  }

  const current = businesses.find((b) => b.id === currentBusinessId) ?? businesses[0]!;

  // If there's only one business, just display it without a dropdown.
  if (businesses.length === 1) {
    return (
      <div className="flex h-10 items-center px-4 rounded-full border border-line bg-surface">
        <span className="text-[15px] font-semibold text-ink truncate">{current.name}</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-full border border-line bg-white px-4 h-10 hover:bg-surface transition-colors"
      >
        <span className="text-[15px] font-semibold text-ink truncate max-w-[120px]">{current?.name}</span>
        <svg className="w-4 h-4 text-ink flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 w-64 bg-white rounded-2xl border border-line shadow-xl overflow-hidden max-h-60 overflow-y-auto">
            {businesses.map((business) => (
              <Link
                key={business.id}
                href={`/dashboard/${business.id}`}
                onClick={() => setIsOpen(false)}
                className={`block px-4 py-3 hover:bg-surface transition-colors ${
                  business.id === currentBusinessId ? 'bg-surface' : ''
                }`}
              >
                <p className="text-[15px] font-semibold text-ink truncate">{business.name}</p>
                <p className="text-[13px] text-muted mt-0.5 capitalize">{business.category}</p>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
