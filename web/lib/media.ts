/**
 * Shared by the upload widgets and the public pages. No server-only imports,
 * so client components can use it.
 */

/** Mirrors backend/src/images/process.ts. The backend is the real check. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const GALLERY_MAX = 12;

/** Widths the backend writes per kind, largest first. */
const WIDTHS: Record<string, number[]> = {
  logo: [512, 256],
  cover: [1920, 1280, 640],
  service: [1200, 600],
  staff: [512, 256],
  gallery: [1600, 800],
};

/** `…/b/<business>/<kind>/<32-hex id>/<width>.webp` — only URLs the backend issued. */
const UPLOADED = /^(https:\/\/.+\/b\/[^/]+\/(logo|cover|service|staff|gallery)\/[0-9a-f]{32})\/\d+\.webp$/;

/**
 * `srcset` for an uploaded image, so a phone downloads the 640px cover rather
 * than the 1920px one. Pasted links (and anything else) get no srcset — the
 * browser just uses `src`.
 */
export function srcSet(url: string | null | undefined): string | undefined {
  const m = url ? UPLOADED.exec(url) : null;
  if (!m) return undefined;
  return WIDTHS[m[2]!]!.map((w) => `${m[1]}/${w}.webp ${w}w`).join(', ');
}

/** Client-side pre-check, so an obviously wrong file fails instantly. */
export function checkImageFile(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a JPEG, PNG or WebP image.';
  }
  if (file.size > MAX_IMAGE_BYTES) return 'Images must be under 8 MB.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}
