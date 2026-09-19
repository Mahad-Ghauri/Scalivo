'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

interface PaginationProps {
  total: number;
  pageSize: number;
  currentPage: number;
}

export function Pagination({ total, pageSize, currentPage }: PaginationProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  const createPageUrl = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', page.toString());
    return `${pathname}?${params.toString()}`;
  };

  return (
    <nav className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-6" aria-label="Pagination">
      <div className="hidden sm:block">
        <p className="text-[14px] text-muted">
          Showing <span className="font-medium text-ink">{(currentPage - 1) * pageSize + 1}</span> to{' '}
          <span className="font-medium text-ink">{Math.min(currentPage * pageSize, total)}</span> of{' '}
          <span className="font-medium text-ink">{total}</span> results
        </p>
      </div>
      <div className="flex flex-1 justify-between sm:justify-end gap-2">
        {currentPage > 1 ? (
          <Link
            href={createPageUrl(currentPage - 1)}
            className="relative inline-flex items-center rounded-full bg-white px-4 py-2 text-[14px] font-semibold text-ink border border-line hover:bg-surface transition-colors"
          >
            Previous
          </Link>
        ) : (
          <span className="relative inline-flex items-center rounded-full bg-surface/50 px-4 py-2 text-[14px] font-semibold text-muted border border-transparent cursor-not-allowed">
            Previous
          </span>
        )}
        
        {currentPage < totalPages ? (
          <Link
            href={createPageUrl(currentPage + 1)}
            className="relative inline-flex items-center rounded-full bg-white px-4 py-2 text-[14px] font-semibold text-ink border border-line hover:bg-surface transition-colors"
          >
            Next
          </Link>
        ) : (
          <span className="relative inline-flex items-center rounded-full bg-surface/50 px-4 py-2 text-[14px] font-semibold text-muted border border-transparent cursor-not-allowed">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
