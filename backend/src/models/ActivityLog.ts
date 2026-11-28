import { Schema, model } from 'mongoose';

/**
 * One owner or staff action on the dashboard or app: "who changed what, when".
 * Written by audit/activity.ts after a successful request, read by the audit report.
 */
const schema = new Schema(
  {
    businessId: { type: String, required: true },
    actorId: { type: String, required: true },
    actorName: { type: String, default: null },
    category: { type: String, required: true },
    action: { type: String, required: true },
    targetId: { type: String, default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ businessId: 1, createdAt: -1 });

export const ActivityLog = model('ActivityLog', schema);
