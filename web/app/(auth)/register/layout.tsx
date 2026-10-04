import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** Title only — the group layout already keeps this route out of the index. */
export const metadata: Metadata = { title: 'Create account' };

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
