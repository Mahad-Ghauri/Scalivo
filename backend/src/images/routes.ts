import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { param } from '../http/params.js';
import { logger } from '../lib/logger.js';
import { objectStore, type ObjectStore } from '../storage/index.js';
import { ImageBusy, ImageRejected, MAX_UPLOAD_BYTES, SPECS, type ImageKind } from './process.js';
import {
  GALLERY_MAX,
  UploadFailed,
  removeGalleryImage,
  removeImage,
  reorderGallery,
  updateGalleryAlt,
  uploadImage,
  type Slot,
} from './service.js';

/**
 * Owner image endpoints. Every route: signed-in owner of :businessId
 * (requireTenant), per-business rate limit, hard 8 MB body cap.
 *
 *   PUT    /:businessId/images/logo | cover            raw image body
 *   DELETE /:businessId/images/logo | cover
 *   POST   /:businessId/images/gallery?alt=…           raw image body
 *   PATCH  /:businessId/images/gallery/:imageId        { alt }
 *   PUT    /:businessId/images/gallery/order           { imageIds: [...] }
 *   DELETE /:businessId/images/gallery/:imageId
 *   PUT    /:businessId/services/:serviceId/image      raw image body
 *   DELETE /:businessId/services/:serviceId/image
 *   PUT    /:businessId/staff/:staffId/photo?consent=true
 *   DELETE /:businessId/staff/:staffId/photo
 *
 * The body is the image bytes themselves (`Content-Type: image/jpeg` etc.),
 * not multipart: one file per request, nothing to parse, and the format is
 * read from the bytes regardless of what the header claims.
 *
 * Responses carry public URLs only — never the bucket, the signed endpoint,
 * object keys beyond what the URL already shows, or a storage error's detail.
 */

const UPLOADS_PER_HOUR = 60;
const imageIdPattern = /^[0-9a-f]{32}$/;
const altSchema = z.string().trim().min(1).max(200);

const MESSAGES: Record<string, { status: number; error: string }> = {
  unsupported_format: { status: 415, error: 'Upload a JPEG, PNG or WebP image.' },
  unreadable: { status: 400, error: "That file couldn't be read as an image." },
  too_small: { status: 400, error: 'That image is too small. Use a larger photo.' },
  too_large: { status: 413, error: 'Images must be under 8 MB.' },
  empty: { status: 400, error: 'Choose an image to upload.' },
  invalid_alt: { status: 400, error: 'Describe the photo in 1–200 characters.' },
  consent_required: {
    status: 400,
    error: 'Confirm this person agreed to their photo being shown publicly.',
  },
  not_found: { status: 404, error: 'Not found.' },
  gallery_full: {
    status: 409,
    error: `The portfolio holds up to ${GALLERY_MAX} photos. Remove one first.`,
  },
  quota_reached: {
    status: 409,
    error: 'Image limit reached for this business. Remove unused images first.',
  },
  stale: { status: 409, error: 'The portfolio changed. Reload and try again.' },
  rate_limited: { status: 429, error: 'Too many uploads. Try again in a while.' },
  busy: { status: 503, error: 'Image uploads are busy. Try again in a moment.' },
  storage_unavailable: {
    status: 503,
    error: 'Image uploads are unavailable right now. Try again shortly.',
  },
};

function refuse(res: Response, reason: keyof typeof MESSAGES, extra: Record<string, unknown> = {}) {
  const m = MESSAGES[reason]!;
  if (m.status === 503) res.setHeader('Retry-After', '30');
  res.status(m.status).json({ error: m.error, reason, ...extra });
}

/** Raw body, capped, with JSON errors instead of Express's HTML error page. */
function imageBody(req: Request, res: Response, next: NextFunction) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    // Refused before reading a byte of it.
    req.resume();
    refuse(res, 'too_large');
    return;
  }
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err?: unknown) => {
    if (err) {
      const type = (err as { type?: string }).type;
      refuse(res, type === 'entity.too.large' ? 'too_large' : 'unreadable');
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      refuse(res, 'empty');
      return;
    }
    next();
  });
}

export function createImageRouter(redis: Redis): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;
  const json = express.json({ limit: '4kb' });

  /** Per BUSINESS, so one owner's script cannot exhaust the processors for everyone. */
  async function underRateLimit(businessId: string): Promise<boolean> {
    try {
      const key = `rl:images:${businessId}:${Math.floor(Date.now() / 3_600_000)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 3600);
      return count <= UPLOADS_PER_HOUR;
    } catch {
      return true; // fail open: Redis down must not take uploads with it
    }
  }

  function storeOr503(res: Response): ObjectStore | null {
    const store = objectStore();
    if (!store) refuse(res, 'storage_unavailable');
    return store;
  }

  async function handleUpload(
    req: Request,
    res: Response,
    slot: Slot,
    extra: { alt?: string } = {},
  ) {
    const store = storeOr503(res);
    if (!store) return;
    if (!(await underRateLimit(slot.businessId))) return refuse(res, 'rate_limited');
    try {
      const image = await uploadImage(store, slot, req.body as Buffer, extra);
      res.status(201).json({ image });
    } catch (err) {
      if (err instanceof ImageRejected) {
        return refuse(
          res,
          err.reason,
          err.reason === 'too_small' ? { minSide: SPECS[slot.kind].minSide } : {},
        );
      }
      if (err instanceof ImageBusy) return refuse(res, 'busy');
      if (err instanceof UploadFailed) return refuse(res, err.reason);
      logger.error({ err, businessId: slot.businessId, kind: slot.kind }, 'image upload failed');
      refuse(res, 'storage_unavailable');
    }
  }

  async function handleRemove(res: Response, slot: Slot) {
    const store = storeOr503(res);
    if (!store) return;
    try {
      await removeImage(store, slot);
      res.status(204).end();
    } catch (err) {
      if (err instanceof UploadFailed) return refuse(res, err.reason);
      logger.error({ err, businessId: slot.businessId, kind: slot.kind }, 'image removal failed');
      refuse(res, 'storage_unavailable');
    }
  }

  for (const kind of ['logo', 'cover'] as const satisfies readonly ImageKind[]) {
    router.put(`/:businessId/images/${kind}`, ...guard, imageBody, (req, res) =>
      handleUpload(req, res, { businessId: param(req, 'businessId'), kind }),
    );
    router.delete(`/:businessId/images/${kind}`, ...guard, (req, res) =>
      handleRemove(res, { businessId: param(req, 'businessId'), kind }),
    );
  }

  router.post('/:businessId/images/gallery', ...guard, imageBody, (req, res) => {
    const alt = altSchema.safeParse(req.query.alt);
    if (!alt.success) return refuse(res, 'invalid_alt');
    return handleUpload(
      req,
      res,
      { businessId: param(req, 'businessId'), kind: 'gallery' },
      { alt: alt.data },
    );
  });

  // Registered before '/gallery/:imageId' so "order" is never read as an id.
  router.put('/:businessId/images/gallery/order', ...guard, json, async (req, res) => {
    const parsed = z
      .object({ imageIds: z.array(z.string().regex(imageIdPattern)).max(GALLERY_MAX) })
      .safeParse(req.body);
    if (!parsed.success) return refuse(res, 'not_found');
    const ok = await reorderGallery(param(req, 'businessId'), parsed.data.imageIds);
    if (!ok) return refuse(res, 'stale');
    res.status(204).end();
  });

  router.patch('/:businessId/images/gallery/:imageId', ...guard, json, async (req, res) => {
    const imageId = param(req, 'imageId');
    const alt = altSchema.safeParse(req.body?.alt);
    if (!imageIdPattern.test(imageId)) return refuse(res, 'not_found');
    if (!alt.success) return refuse(res, 'invalid_alt');
    if (!(await updateGalleryAlt(param(req, 'businessId'), imageId, alt.data)))
      return refuse(res, 'not_found');
    res.status(204).end();
  });

  router.delete('/:businessId/images/gallery/:imageId', ...guard, async (req, res) => {
    const store = storeOr503(res);
    if (!store) return;
    const imageId = param(req, 'imageId');
    if (!imageIdPattern.test(imageId)) return refuse(res, 'not_found');
    if (!(await removeGalleryImage(store, param(req, 'businessId'), imageId)))
      return refuse(res, 'not_found');
    res.status(204).end();
  });

  router.put('/:businessId/services/:serviceId/image', ...guard, imageBody, (req, res) =>
    handleUpload(req, res, {
      businessId: param(req, 'businessId'),
      kind: 'service',
      targetId: param(req, 'serviceId'),
    }),
  );
  router.delete('/:businessId/services/:serviceId/image', ...guard, (req, res) =>
    handleRemove(res, {
      businessId: param(req, 'businessId'),
      kind: 'service',
      targetId: param(req, 'serviceId'),
    }),
  );

  router.put('/:businessId/staff/:staffId/photo', ...guard, imageBody, (req, res) => {
    // Consent is the owner's statement, checked before any processing work.
    if (req.query.consent !== 'true') return refuse(res, 'consent_required');
    return handleUpload(req, res, {
      businessId: param(req, 'businessId'),
      kind: 'staff',
      targetId: param(req, 'staffId'),
    });
  });
  router.delete('/:businessId/staff/:staffId/photo', ...guard, (req, res) =>
    handleRemove(res, {
      businessId: param(req, 'businessId'),
      kind: 'staff',
      targetId: param(req, 'staffId'),
    }),
  );

  return router;
}
