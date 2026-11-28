import { Schema, model } from 'mongoose';

/**
 * One uploaded image and the objects it wrote to storage.
 *
 * The row is written BEFORE the objects (status `pending`) and moved to
 * `active` only once the owning document points at it. That ordering is what
 * makes the bucket recoverable: a crash mid-upload leaves a `pending` row the
 * sweeper deletes, never an object nothing knows about. Replaced and removed
 * images go to `released` and the sweeper deletes their objects — a failed
 * delete is retried there instead of leaking a file forever.
 *
 * Holds no URL: object keys are derived from (businessId, kind, imageId,
 * width), so the bucket layout can never drift from what the row says.
 */
const storedImageSchema = new Schema(
  {
    /** Random, unguessable, also the object path segment. */
    imageId: { type: String, required: true, unique: true },
    businessId: { type: String, required: true },
    kind: {
      type: String,
      enum: ['logo', 'cover', 'service', 'staff', 'gallery'],
      required: true,
    },
    /** Service or staff id for those kinds; null for business-level images. */
    targetId: { type: String, default: null },
    widths: { type: [Number], required: true },
    bytes: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'released', 'deleted'],
      default: 'pending',
    },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** Quota count and the per-target lookup on replace. */
storedImageSchema.index({ businessId: 1, status: 1, kind: 1, targetId: 1 });
/** The sweeper: pending/released rows, oldest first. */
storedImageSchema.index({ status: 1, updatedAt: 1 });

export const StoredImage = model('StoredImage', storedImageSchema);
