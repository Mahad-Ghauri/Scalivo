import Link from 'next/link';
import type { ReactNode } from 'react';

import { MenuIcon } from '@/components/Icons';

const pill =
  'inline-flex h-12 items-center gap-2 rounded-full border border-line bg-white px-5 text-[15px] font-semibold transition-colors hover:bg-surface';

/**
 * `search` slots the compact search pill into the middle of the bar, as every
 * page except the home page does. On a phone it drops below the logo row.
 */
export function SiteHeader({ search, transparent = false }: { search?: ReactNode; transparent?: boolean }) {
  return (
    <header className={transparent ? '' : 'border-b border-line bg-white'}>
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3 md:px-8 md:py-3">
        <Link href="/" className="text-[26px] font-bold leading-none tracking-[-0.04em]">
          scalivo
        </Link>

        {search ? <div className="order-3 w-full md:order-none md:mx-auto md:w-auto md:min-w-[600px]">{search}</div> : null}

        <nav aria-label="Primary" className="ml-auto flex items-center gap-2 md:gap-3">
          {search ? null : (
            <Link href="/search" className="hidden px-4 text-[15px] font-semibold sm:inline">
              Search
            </Link>
          )}
          <Link href="/#for-business" className={`${pill} hidden sm:inline-flex`}>
            For businesses
          </Link>
          <Link href="/#browse" className={pill}>
            Menu
            <MenuIcon />
          </Link>
        </nav>
      </div>
    </header>
  );
}
