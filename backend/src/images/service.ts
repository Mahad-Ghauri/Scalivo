import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { StoredImage } from '../models/StoredImage.js';
import { logger } from '../lib/logger.js';
import type { ObjectStore } from '../storage/index.js';
import { type ImageKind, SPECS, processImage } from './process.js';

/**
 * Uploading, replacing and removing images — the lifecycle around
 * processImage().
 *
 * Order of operations, and why:
 *
 *   1. process      — reject bad input before anything is written anywhere
 *   2. row: pending — the bucket is never ahead of the database
 *   3. put objects  — all variants in parallel
 *   4. attach       — the owning document now points at the new URL
 *   5. row: active, and every OTHER active image for that slot is released
 *   6. release      — old objects deleted now, or by the sweeper if that fails
 *
 * Step 5 decides the survivor from what the document references AFTER the
 * write, not from what was there before it. Two uploads to the same slot can
 * interleave in any order and the one the document ends up pointing at is
 * the one kept — the other is released, never leaked and never deleted while
 * still referenced.
 */

export const GALLERY_MAX = 12;
export const MAX_IMAGES_PER_BUSINESS = 150;

export type UploadFailure = 'not_found' | 'gallery_full' | 'quota_reached' | 'storage_unavailable';

export class UploadFailed extends Error {
  constructor(readonly reason: UploadFailure) {
    super(reason);
    this.name = 'UploadFailed';
  }
}

export interface UploadedImage {
  id: string;
  url: string;
  variants: { width: number; height: number; url: string }[];
}

export interface Slot {
  businessId: string;
  kind: ImageKind;
  /** Service or staff id; absent for logo/cover/gallery. */
  targetId?: string;
}

export const objectKey = (businessId: string, kind: string, imageId: string, width: number) =>
  `b/${businessId}/${kind}/${imageId}/${width}.webp`;

const primaryUrl = (store: ObjectStore, slot: Slot, imageId: string) =>
  store.publicUrl(objectKey(slot.businessId, slot.kind, imageId, SPECS[slot.kind].primary));

/* ─────────────────────────────── upload ──────────────────────────────── */

export async function uploadImage(
  store: ObjectStore,
  slot: Slot,
  body: Uint8Array,
  extra: { alt?: string } = {},
): Promise<UploadedImage> {
  await assertTarget(slot);

  const inUse = await StoredImage.countDocuments({
    businessId: slot.businessId,
    status: { $in: ['pending', 'active'] },
  });
  if (inUse >= MAX_IMAGES_PER_BUSINESS) throw new UploadFailed('quota_reached');
  if (slot.kind === 'gallery' && (await galleryLength(slot.businessId)) >= GALLERY_MAX) {
    throw new UploadFailed('gallery_full');
  }

  const variants = await processImage(body, slot.kind);
  const imageId = randomBytes(16).toString('hex');
  const spec = SPECS[slot.kind];

  const row = await StoredImage.create({
    imageId,
    businessId: slot.businessId,
    kind: slot.kind,
    targetId: slot.targetId ?? null,
    widths: spec.widths,
    bytes: variants.reduce((sum, v) => sum + v.body.length, 0),
    status: 'pending',
  });

  try {
    await Promise.all(
      variants.map((v, i) =>
        store.put(
          objectKey(slot.businessId, slot.kind, imageId, spec.widths[i]!),
          v.body,
          'image/webp',
        ),
      ),
    );
  } catch (err) {
    logger.warn(
      { err, businessId: slot.businessId, kind: slot.kind },
      'image upload to storage failed',
    );
    await release(store, [row.imageId]);
    throw new UploadFailed('storage_unavailable');
  }

  const url = primaryUrl(store, slot, imageId);
  const attached = await attach(slot, url, imageId, extra.alt);
  if (!attached) {
    await release(store, [row.imageId]);
    // The pre-check passed but another upload filled the last place meanwhile.
    throw new UploadFailed(slot.kind === 'gallery' ? 'gallery_full' : 'not_found');
  }

  await StoredImage.updateOne({ _id: row._id }, { $set: { status: 'active' } });
  if (slot.kind !== 'gallery') await releaseUnreferenced(store, slot);

  return {
    id: imageId,
    url,
    variants: variants.map((v, i) => ({
      width: v.width,
      height: v.height,
      url: store.publicUrl(objectKey(slot.businessId, slot.kind, imageId, spec.widths[i]!)),
    })),
  };
}

/* ─────────────────────────────── remove ──────────────────────────────── */

/** Clears a single-image slot (logo, cover, service, staff). Idempotent. */
export async function removeImage(store: ObjectStore, slot: Slot): Promise<boolean> {
  await assertTarget(slot);
  switch (slot.kind) {
    case 'logo':
      await Business.updateOne({ _id: slot.businessId }, { $set: { 'profile.logoUrl': null } });
      break;
    case 'cover':
      await Business.updateOne({ _id: slot.businessId }, { $set: { 'profile.coverUrl': null } });
      break;
    case 'service':
      await Service.updateOne(
        { _id: slot.targetId, businessId: slot.businessId },
        { $set: { imageUrl: null } },
      );
      break;
    case 'staff':
      await Staff.updateOne(
        { _id: slot.targetId, businessId: slot.businessId },
        { $set: { avatarUrl: null, photoConsentAt: null } },
      );
      break;
    case 'gallery':
      throw new Error('use removeGalleryImage');
  }
  await releaseUnreferenced(store, slot);
  return true;
}

export async function removeGalleryImage(
  store: ObjectStore,
  businessId: string,
  imageId: string,
): Promise<boolean> {
  const result = await Business.updateOne(
    { _id: businessId, 'profile.gallery.imageId': imageId },
    { $pull: { 'profile.gallery': { imageId } } },
  );
  if (result.modifiedCount === 0) return false;
  await release(store, [imageId], businessId);
  return true;
}

export async function updateGalleryAlt(businessId: string, imageId: string, alt: string) {
  const result = await Business.updateOne(
    { _id: businessId, 'profile.gallery.imageId': imageId },
    { $set: { 'profile.gallery.$.alt': alt } },
  );
  return result.matchedCount === 1;
}

/**
 * Reorder by uploaded ids. Entries without an id (pasted links) keep their
 * relative order after the uploaded ones. The update is conditional on the
 * gallery being exactly what was read, so a concurrent upload or delete makes
 * this answer `false` (retry) rather than silently dropping a photo.
 */
export async function reorderGallery(businessId: string, imageIds: string[]): Promise<boolean> {
  const business = await Business.findById(businessId).select('profile.gallery').lean();
  const gallery = business?.profile?.gallery ?? [];
  const uploaded = gallery.filter((g) => g.imageId);
  if (
    imageIds.length !== uploaded.length ||
    new Set(imageIds).size !== imageIds.length ||
    !imageIds.every((id) => uploaded.some((g) => g.imageId === id))
  ) {
    return false;
  }
  const next = [
    ...imageIds.map((id) => uploaded.find((g) => g.imageId === id)!),
    ...gallery.filter((g) => !g.imageId),
  ];
  const result = await Business.updateOne(
    { _id: businessId, 'profile.gallery': gallery },
    { $set: { 'profile.gallery': next } },
  );
  return result.modifiedCount === 1 || JSON.stringify(next) === JSON.stringify(gallery);
}

/* ─────────────────────────────── internals ───────────────────────────── */

async function assertTarget(slot: Slot): Promise<void> {
  if (!mongoose.isValidObjectId(slot.businessId)) throw new UploadFailed('not_found');
  if (slot.kind === 'service' || slot.kind === 'staff') {
    if (!slot.targetId || !mongoose.isValidObjectId(slot.targetId))
      throw new UploadFailed('not_found');
    const Model = slot.kind === 'service' ? Service : Staff;
    const exists = await (Model as typeof Service).exists({
      _id: slot.targetId,
      businessId: slot.businessId,
    });
    if (!exists) throw new UploadFailed('not_found');
  } else if (!(await Business.exists({ _id: slot.businessId }))) {
    throw new UploadFailed('not_found');
  }
}

async function galleryLength(businessId: string): Promise<number> {
  const [row] = await Business.aggregate<{ n: number }>([
    { $match: { _id: new mongoose.Types.ObjectId(businessId) } },
    { $project: { n: { $size: { $ifNull: ['$profile.gallery', []] } } } },
  ]);
  return row?.n ?? 0;
}

async function attach(slot: Slot, url: string, imageId: string, alt?: string): Promise<boolean> {
  switch (slot.kind) {
    case 'logo':
    case 'cover': {
      const field = slot.kind === 'logo' ? 'profile.logoUrl' : 'profile.coverUrl';
      const r = await Business.updateOne({ _id: slot.businessId }, { $set: { [field]: url } });
      return r.matchedCount === 1;
    }
    case 'gallery': {
      // Atomic cap: the 13th element must not exist for the push to apply.
      const r = await Business.updateOne(
        { _id: slot.businessId, [`profile.gallery.${GALLERY_MAX - 1}`]: { $exists: false } },
        { $push: { 'profile.gallery': { url, alt: alt ?? '', imageId } } },
      );
      return r.modifiedCount === 1;
    }
    case 'service': {
      const r = await Service.updateOne(
        { _id: slot.targetId, businessId: slot.businessId },
        { $set: { imageUrl: url } },
      );
      return r.matchedCount === 1;
    }
    case 'staff': {
      const r = await Staff.updateOne(
        { _id: slot.targetId, businessId: slot.businessId },
        { $set: { avatarUrl: url, photoConsentAt: new Date() } },
      );
      return r.matchedCount === 1;
    }
  }
}

/** The URL the slot's document points at right now. */
async function currentUrl(slot: Slot): Promise<string | null> {
  switch (slot.kind) {
    case 'logo':
    case 'cover': {
      const b = await Business.findById(slot.businessId)
        .select('profile.logoUrl profile.coverUrl')
        .lean();
      return (slot.kind === 'logo' ? b?.profile?.logoUrl : b?.profile?.coverUrl) ?? null;
    }
    case 'service':
      return (await Service.findById(slot.targetId).select('imageUrl').lean())?.imageUrl ?? null;
    case 'staff':
      return (await Staff.findById(slot.targetId).select('avatarUrl').lean())?.avatarUrl ?? null;
    case 'gallery':
      return null;
  }
}

/** Release every active image in a single-image slot except the one referenced. */
export async function releaseUnreferenced(store: ObjectStore, slot: Slot): Promise<void> {
  const url = await currentUrl(slot);
  const keep = url
    ? (/\/([0-9a-f]{32})\/\d+\.webp$/.exec(store.keyFromUrl(url) ?? '')?.[1] ?? null)
    : null;
  const stale = await StoredImage.find({
    businessId: slot.businessId,
    kind: slot.kind,
    targetId: slot.targetId ?? null,
    status: 'active',
    ...(keep ? { imageId: { $ne: keep } } : {}),
  })
    .select('imageId')
    .lean();
  if (stale.length)
    await release(
      store,
      stale.map((s) => s.imageId),
      slot.businessId,
    );
}

/**
 * Mark released, then delete the objects. A delete that fails leaves the row
 * `released` and the sweeper (sweep.ts) retries it, so storage failures can
 * delay a deletion but never lose track of a file.
 */
export async function release(store: ObjectStore, imageIds: string[], businessId?: string) {
  await StoredImage.updateMany(
    {
      imageId: { $in: imageIds },
      ...(businessId ? { businessId } : {}),
      status: { $ne: 'deleted' },
    },
    { $set: { status: 'released', releasedAt: new Date() } },
  );
  const rows = await StoredImage.find({ imageId: { $in: imageIds }, status: 'released' }).lean();
  await Promise.all(rows.map((row) => deleteObjects(store, row)));
}

export async function deleteObjects(
  store: ObjectStore,
  row: { imageId: string; businessId: string; kind: string; widths: number[] },
): Promise<boolean> {
  try {
    await Promise.all(
      row.widths.map((w) => store.delete(objectKey(row.businessId, row.kind, row.imageId, w))),
    );
    await StoredImage.updateOne(
      { imageId: row.imageId, status: 'released' },
      { $set: { status: 'deleted' } },
    );
    return true;
  } catch (err) {
    logger.warn({ err, imageId: row.imageId }, 'image delete failed; the sweeper will retry');
    return false;
  }
}
