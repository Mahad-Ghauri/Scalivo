import type { ReactNode } from 'react';
import { GrainOverlay } from '@/components/GrainOverlay';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GrainOverlay />
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
