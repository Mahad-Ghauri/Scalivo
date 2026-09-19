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
      <div className="px-4 py-3 border-b border-rule bg-paper">
        <p className="text-sm font-medium text-ink truncate">{current.name}</p>
        <p className="text-xs text-muted mt-0.5 capitalize">{current.category}</p>
      </div>
    );
  }

  return (
    <div className="relative border-b border-rule bg-paper">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-stone-50 transition-colors text-left"
      >
        <div className="overflow-hidden">
          <p className="text-sm font-medium text-ink truncate">{current?.name}</p>
          <p className="text-xs text-muted mt-0.5 capitalize">{current?.category}</p>
        </div>
        <svg className="w-4 h-4 text-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 right-0 z-50 bg-paper border-b border-rule shadow-lg max-h-60 overflow-y-auto">
            {businesses.map((business) => (
              <Link
                key={business.id}
                href={`/dashboard/${business.id}`}
                onClick={() => setIsOpen(false)}
                className={`block px-4 py-3 hover:bg-stone-50 transition-colors ${
                  business.id === currentBusinessId ? 'bg-stone-50/50' : ''
                }`}
              >
                <p className="text-sm font-medium text-ink truncate">{business.name}</p>
                <p className="text-xs text-muted mt-0.5 capitalize">{business.category}</p>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
