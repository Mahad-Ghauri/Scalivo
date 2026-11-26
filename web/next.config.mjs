/**
 * Headers for the personal token pages — a customer's appointments (`/me`) and
 * a deposit payment (`/pay`).
 *
 * - X-Robots-Tag: `noindex` as a header as well as in the page, so it also
 *   covers responses that never render the page's metadata (errors, redirects).
 * - Referrer-Policy: the token is in the URL, and these pages link out (WhatsApp,
 *   the payment gateway). Without this the full URL — token included — travels
 *   to that site in the Referer header.
 */
const tokenPageHeaders = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'private, no-store' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `@scalivo/shared` ships as workspace TypeScript compiled to ESM. Next has to
  // be told to transpile it rather than treat it as an opaque node_modules dep.
  transpilePackages: ['@scalivo/shared'],

  async headers() {
    return [
      { source: '/me/:path*', headers: tokenPageHeaders },
      { source: '/pay/:path*', headers: tokenPageHeaders },
    ];
  },
};

export default nextConfig;
