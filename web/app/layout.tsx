import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Plus_Jakarta_Sans } from 'next/font/google';

import { SiteFooter } from '@/components/SiteFooter';
import { SITE_URL } from '@/lib/site';

import './globals.css';

/** One family, several weights: a geometric grotesk with a friendly, rounded feel. */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Scalivo — book salons, clinics, gyms and studios',
    template: '%s · Scalivo',
  },
  description:
    'Discover top-rated salons, clinics, gyms and studios across Multan and Lahore. See prices, hours and staff, then book over WhatsApp.',
  openGraph: {
    type: 'website',
    siteName: 'Scalivo',
    url: SITE_URL,
    title: 'Scalivo — book salons, clinics, gyms and studios',
    description: 'Prices, hours and staff for service businesses across Multan and Lahore. Booked over WhatsApp.',
  },
  twitter: { card: 'summary_large_image' },
};

/** The header is rendered by each page: the home page lays it over the hero, the rest give it a search bar. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="min-h-screen antialiased">
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
