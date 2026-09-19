/** One place for the public origin: metadata, canonicals, sitemap and robots all need it. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://scalivo.app';

/**
 * The backend. Public and unauthenticated by design — the marketplace pages
 * read it on the server, and the booking steps call it from the browser.
 * Here rather than in marketplace.ts so a client component can import it
 * without dragging the fixtures into the browser bundle.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';
