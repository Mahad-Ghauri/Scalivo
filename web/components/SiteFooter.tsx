import Link from 'next/link';

import { Logo } from '@/components/Logo';

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Browse',
    links: [
      { href: '/search', label: 'All businesses' },
      { href: '/?category=clinic#results', label: 'Clinics' },
      { href: '/?category=salon#results', label: 'Salons' },
      { href: '/?category=gym#results', label: 'Gyms' },
    ],
  },
  {
    heading: 'Cities',
    links: [
      { href: '/?city=Multan#results', label: 'Multan' },
      { href: '/?city=Lahore#results', label: 'Lahore' },
    ],
  },
  {
    heading: 'For business',
    links: [
      { href: '/#for-business', label: 'List your business' },
      { href: 'mailto:hello@scalivo.app', label: 'Contact us' },
    ],
  },
];

export function SiteFooter() {
  return (
    // Never on paper: a printed poster or receipt is not a page of navigation links.
    <footer className="mt-24 bg-surface print:hidden">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-10 px-5 py-14 md:grid-cols-5 md:px-8">
        <div className="col-span-2">
          <p className="text-[26px] font-bold leading-none tracking-[-0.04em]">
            <Logo />
          </p>
          <p className="mt-4 max-w-[34ch] text-[15px] text-muted">
            Book salons, clinics, gyms and studios in Multan and Lahore, confirmed over WhatsApp.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            <h2 className="text-[16px] font-semibold">{column.heading}</h2>
            <ul className="mt-4 space-y-3">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[15px] hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="mx-auto flex max-w-[1440px] flex-wrap justify-between gap-3 border-t border-line px-5 py-6 text-[14px] text-muted md:px-8">
        <p>Prices in PKR · Times in Pakistan Standard Time</p>
        <p>© {new Date().getFullYear()} Scalivo</p>
      </div>
    </footer>
  );
}
