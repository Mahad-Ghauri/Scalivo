import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { StoredImage } from '../models/StoredImage.js';
import { logger } from '../lib/logger.js';
import { objectStore, type ObjectStore } from '../storage/index.js';
import { SPECS, type ImageKind } from './process.js';
import { deleteObjects, objectKey } from './service.js';

/**
 * Keeping the bucket in step with the database.
 *
 * - `released` rows: a delete that failed at the time. Retried here.
 * - `pending` rows older than STALE_MS: an upload that crashed between writing
 *   objects and attaching them. Before deleting, the document is checked — if
 *   the crash came AFTER the attach, the image is live and the row is promoted
 *   to `active` instead. Deleting a referenced image is the one mistake this
 *   must never make.
 */

const INTERVAL_MS = 15 * 60_000;
const STALE_MS = 60 * 60_000;
const BATCH = 200;

export async function sweepImages(
  store: ObjectStore,
  now = new Date(),
): Promise<{ deleted: number; promoted: number }> {
  let deleted = 0;
  let promoted = 0;

  const rows = await StoredImage.find({
    $or: [
      { status: 'released' },
      { status: 'pending', updatedAt: { $lt: new Date(now.getTime() - STALE_MS) } },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH)
    .lean();

  for (const row of rows) {
    if (row.status === 'pending') {
      if (await isReferenced(store, row)) {
        await StoredImage.updateOne(
          { _id: row._id, status: 'pending' },
          { $set: { status: 'active' } },
        );
        promoted++;
        continue;
      }
      await StoredImage.updateOne(
        { _id: row._id, status: 'pending' },
        { $set: { status: 'released', releasedAt: now } },
      );
    }
    if (await deleteObjects(store, row)) deleted++;
  }
  // Safety net for any path that drops a reference without releasing (an
  // edit elsewhere, a manual DB change): re-check the least recently verified
  // active rows and release the ones nothing points at. Touching updatedAt on
  // the survivors rotates the check through every row over time.
  const active = await StoredImage.find({
    status: 'active',
    updatedAt: { $lt: new Date(now.getTime() - STALE_MS) },
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH)
    .lean();
  for (const row of active) {
    if (await isReferenced(store, row)) {
      await StoredImage.updateOne(
        { _id: row._id },
        { $set: { updatedAt: now } },
        { timestamps: false },
      );
      continue;
    }
    await StoredImage.updateOne(
      { _id: row._id, status: 'active' },
      { $set: { status: 'released', releasedAt: now } },
    );
    if (await deleteObjects(store, row)) deleted++;
  }
  return { deleted, promoted };
}

async function isReferenced(
  store: ObjectStore,
  row: { businessId: string; kind: string; imageId: string; targetId?: string | null },
): Promise<boolean> {
  const url = store.publicUrl(
    objectKey(row.businessId, row.kind, row.imageId, SPECS[row.kind as ImageKind].primary),
  );
  switch (row.kind) {
    case 'logo':
      return !!(await Business.exists({ _id: row.businessId, 'profile.logoUrl': url }));
    case 'cover':
      return !!(await Business.exists({ _id: row.businessId, 'profile.coverUrl': url }));
    case 'gallery':
      return !!(await Business.exists({
        _id: row.businessId,
        'profile.gallery.imageId': row.imageId,
      }));
    case 'service':
      return !!(await Service.exists({ _id: row.targetId, imageUrl: url }));
    case 'staff':
      return !!(await Staff.exists({ _id: row.targetId, avatarUrl: url }));
    default:
      return false;
  }
}

/** Single instance, like the other jobs. No-op when storage isn't configured. */
export function startImageSweepJob(): () => void {
  const run = () => {
    const store = objectStore();
    if (!store) return;
    sweepImages(store)
      .then((r) => {
        if (r.deleted || r.promoted) logger.info(r, 'image sweep');
      })
      .catch((err) => logger.error({ err }, 'image sweep failed'));
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
