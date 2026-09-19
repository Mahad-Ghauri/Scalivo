'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition, useState, useEffect } from 'react';

export function SearchInput({ placeholder = 'Search...', defaultValue = '' }: { placeholder?: string, defaultValue?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(defaultValue);

  // Sync with URL changes
  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (value === defaultValue) return;
      
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set('q', value);
      } else {
        params.delete('q');
      }
      
      // Reset page when searching
      params.delete('page');

      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`);
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [value, pathname, router, searchParams, defaultValue]);

  return (
    <div className="relative w-full max-w-sm">
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="block w-full rounded-full border border-line bg-surface/50 py-2 pl-9 pr-4 text-[14px] text-ink outline-none transition-colors focus:border-ink focus:bg-white focus:ring-1 focus:ring-ink"
      />
      {isPending && (
        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
          <svg className="h-4 w-4 animate-spin text-muted" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
    </div>
  );
}
