import type { ReactNode } from 'react';

export const metadata = {
  title: 'Scalivo',
  description: 'WhatsApp-native booking for salons, clinics, and studios.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
