import sharp from 'sharp';

/**
 * Turning an uploaded photo into the WebP variants a page serves.
 *
 * Every rule here is about the file being someone else's bytes:
 *
 * - The format is decided by the file's own signature, never by its name or
 *   Content-Type, and only JPEG, PNG and WebP are accepted. SVG (which can
 *   carry script), GIF, TIFF and anything else are refused before decoding.
 * - `limitInputPixels` refuses decompression bombs — a few KB that inflate to
 *   gigapixels — before libvips allocates for them.
 * - Output is re-encoded from pixels, so nothing from the original file
 *   survives: EXIF, GPS location, camera serials, embedded thumbnails and ICC
 *   profiles are all dropped (sharp writes no metadata unless asked). A phone
 *   photo of a salon taken at home would otherwise publish that address.
 * - `.rotate()` applies the EXIF orientation first, so a portrait phone photo
 *   is not served sideways once the tag that described it is gone.
 */

export type ImageKind = 'logo' | 'cover' | 'service' | 'staff' | 'gallery';

interface Spec {
  /** Output widths, largest first. */
  widths: number[];
  /** Width ÷ height for cropped kinds; null keeps the photo's own shape. */
  aspect: number | null;
  /** Which width the stored `url` field points at. */
  primary: number;
  /** Smallest acceptable input, on the short side. */
  minSide: number;
}

export const SPECS: Record<ImageKind, Spec> = {
  logo: { widths: [512, 256], aspect: 1, primary: 512, minSide: 128 },
  cover: { widths: [1920, 1280, 640], aspect: 3 / 2, primary: 1280, minSide: 400 },
  service: { widths: [1200, 600], aspect: 4 / 3, primary: 1200, minSide: 300 },
  staff: { widths: [512, 256], aspect: 1, primary: 512, minSide: 128 },
  gallery: { widths: [1600, 800], aspect: null, primary: 1600, minSide: 300 },
};

/** 8 MB on the wire; the HTTP layer enforces it before a byte is buffered beyond. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** 50 MP — above any phone camera, far below a bomb. */
const MAX_INPUT_PIXELS = 50_000_000;

export type ImageRejection = 'unsupported_format' | 'unreadable' | 'too_small' | 'too_large';

export class ImageRejected extends Error {
  constructor(readonly reason: ImageRejection) {
    super(reason);
    this.name = 'ImageRejected';
  }
}

/** The format by magic bytes, or null. */
export function sniff(buf: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return 'png';
  if (
    buf.length >= 12 &&
    String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP'
  )
    return 'webp';
  return null;
}

export interface Variant {
  width: number;
  height: number;
  body: Buffer;
}

/* ───────────────────────── concurrency limiter ───────────────────────── */

/**
 * At most this many images are decoded at once per process. Each decode is a
 * libvips job on the thread pool and can hold ~4 bytes per input pixel, so an
 * unbounded burst of uploads would starve every other request of CPU and
 * memory. Beyond the queue cap the caller is told to retry (503), rather than
 * the server accumulating work it cannot finish.
 */
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 16;
let active = 0;
const waiting: (() => void)[] = [];

export class ImageBusy extends Error {
  constructor() {
    super('image processing is at capacity');
    this.name = 'ImageBusy';
  }
}

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new ImageBusy();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/* ─────────────────────────────── process ─────────────────────────────── */

export async function processImage(input: Uint8Array, kind: ImageKind): Promise<Variant[]> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageRejected('too_large');
  if (!sniff(input)) throw new ImageRejected('unsupported_format');
  const spec = SPECS[kind];

  return limited(async () => {
    let base: sharp.Sharp;
    let meta: sharp.Metadata;
    try {
      // failOn 'error': a truncated or corrupt file is refused, not half-decoded.
      base = sharp(input, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
        pages: 1,
      }).rotate();
      meta = await base.metadata();
    } catch (err) {
      throw new ImageRejected(isPixelLimit(err) ? 'too_large' : 'unreadable');
    }
    if (!meta.width || !meta.height) throw new ImageRejected('unreadable');
    // Read from the header, before any pixel is decoded.
    if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new ImageRejected('too_large');

    // metadata() reports the stored orientation; 5–8 mean the sides swap.
    const swapped = (meta.orientation ?? 1) >= 5;
    const w = swapped ? meta.height : meta.width;
    const h = swapped ? meta.width : meta.height;
    if (Math.min(w, h) < spec.minSide) throw new ImageRejected('too_small');

    try {
      return await Promise.all(
        spec.widths.map(async (width) => {
          const pipeline = base
            .clone()
            .resize(
              spec.aspect
                ? {
                    width,
                    height: Math.round(width / spec.aspect),
                    fit: 'cover',
                    // Crop around the busiest region rather than dead centre.
                    position: sharp.strategy.attention,
                    withoutEnlargement: false,
                  }
                : { width, height: width, fit: 'inside', withoutEnlargement: true },
            )
            .webp({ quality: 82, effort: 4, smartSubsample: true });
          const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
          return { width: info.width, height: info.height, body: data };
        }),
      );
    } catch (err) {
      throw new ImageRejected(isPixelLimit(err) ? 'too_large' : 'unreadable');
    }
  });
}

const isPixelLimit = (err: unknown) =>
  err instanceof Error && /pixel limit|exceeds pixel|Input image exceeds/i.test(err.message);
