import type { NextFunction, Request, Response } from 'express';
import type { AuthToken } from '../auth/jwt.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { User } from '../models/User.js';
import { logger } from '../lib/logger.js';

/**
 * Records every successful owner change under /businesses, so the audit report
 * can answer "who changed what, and when" without each route remembering to.
 *
 * It runs after the response is finished: a failed or rejected request changed
 * nothing and is not logged, and logging can never slow down or break the request.
 */

type Rule = [method: string, pattern: RegExp, category: string, action: string];

const ID = '([a-f\\d]{24}|[\\w-]+)';
const RULES: Rule[] = (
  [
    ['POST', `/bookings/${ID}/reschedule$`, 'booking', 'Rescheduled an appointment'],
    ['POST', `/bookings/${ID}/cancel$`, 'booking', 'Cancelled an appointment'],
    ['POST', `/bookings/${ID}/confirm$`, 'booking', 'Confirmed an appointment'],
    ['POST', `/bookings/${ID}/approve$`, 'booking', 'Approved an appointment'],
    ['POST', `/bookings/${ID}/decline$`, 'booking', 'Declined an appointment'],
    ['POST', `/bookings/${ID}/outcome$`, 'booking', 'Recorded an appointment outcome'],
    ['POST', `/bookings/${ID}/correct`, 'booking', 'Corrected an appointment'],
    ['POST', `/bookings/${ID}/[\\w-]+$`, 'booking', 'Updated an appointment'],
    ['POST', '/bookings$', 'booking', 'Created an appointment'],
    ['POST', '/walk-ins$', 'booking', 'Added a walk-in'],
    ['PUT', `/bookings/${ID}/follow-up$`, 'booking', 'Set a follow-up'],
    ['DELETE', `/bookings/${ID}/follow-up$`, 'booking', 'Removed a follow-up'],
    ['POST', '/blocked-time$', 'calendar', 'Blocked time on the calendar'],
    ['DELETE', `/blocked-time/${ID}$`, 'calendar', 'Removed blocked time'],
    ['POST', '/services$', 'services', 'Added a service'],
    ['PATCH', `/services/${ID}$`, 'services', 'Edited a service'],
    ['DELETE', `/services/${ID}$`, 'services', 'Removed a service'],
    ['PUT', `/services/${ID}/image$`, 'services', 'Changed a service photo'],
    ['DELETE', `/services/${ID}/image$`, 'services', 'Removed a service photo'],
    ['POST', '/staff$', 'staff', 'Added a staff member'],
    ['PATCH', `/staff/${ID}$`, 'staff', 'Edited a staff member'],
    ['DELETE', `/staff/${ID}$`, 'staff', 'Removed a staff member'],
    ['PUT', `/staff/${ID}/photo$`, 'staff', 'Changed a staff photo'],
    ['DELETE', `/staff/${ID}/photo$`, 'staff', 'Removed a staff photo'],
    ['POST', '/resources$', 'services', 'Added a room or equipment'],
    ['PATCH', `/resources/${ID}$`, 'services', 'Edited a room or equipment'],
    ['PUT', `/clients/${ID}/notes$`, 'customers', 'Edited customer notes'],
    ['POST', `/clients/${ID}/[\\w-]+$`, 'customers', 'Updated a customer'],
    ['POST', '/clients[\\w/-]*$', 'customers', 'Imported or added customers'],
    ['POST', '/retention/campaigns$', 'marketing', 'Sent a broadcast'],
    ['POST', `/retention/campaigns/${ID}/cancel$`, 'marketing', 'Cancelled a broadcast'],
    ['PATCH', '/retention/nudges$', 'marketing', 'Changed win-back messages'],
    ['POST', '/grow/boost$', 'marketing', 'Turned on a boost'],
    ['DELETE', '/grow/boost$', 'marketing', 'Turned off a boost'],
    ['PATCH', '/agent/settings$', 'settings', 'Changed assistant settings'],
    ['POST', '/whatsapp/session$', 'whatsapp', 'Started WhatsApp linking'],
    ['POST', '/whatsapp/link$', 'whatsapp', 'Linked WhatsApp'],
    ['POST', '/calendar-feed$', 'settings', 'Created a calendar link'],
    ['DELETE', '/calendar-feed$', 'settings', 'Turned off the calendar link'],
    ['PUT', '/images/[\\w/-]+$', 'settings', 'Changed business photos'],
    ['POST', '/images/[\\w/-]+$', 'settings', 'Added business photos'],
    ['PATCH', '/images/[\\w/-]+$', 'settings', 'Edited business photos'],
    ['DELETE', '/images/[\\w/-]+$', 'settings', 'Removed business photos'],
    ['PATCH', '$', 'settings', 'Changed business settings'],
  ] as const
).map(([method, tail, category, action]) => [
  method,
  new RegExp(`^/[a-f\\d]{24}${tail}`, 'i'),
  category,
  action,
]);

/** Exported for tests: what a request would be recorded as, or null. */
export function describeRequest(method: string, path: string) {
  const rule = RULES.find(([m, pattern]) => m === method && pattern.test(path));
  if (!rule) return null;
  const segments = path.split('/').filter(Boolean);
  const targetId = segments.slice(1).find((s) => /^[a-f\d]{24}$/i.test(s)) ?? null;
  return { businessId: segments[0]!, category: rule[2], action: rule[3], targetId };
}

const names = new Map<string, string | null>();
async function actorName(userId: string): Promise<string | null> {
  if (!names.has(userId)) {
    const user = await User.findById(userId).select('name email').lean();
    names.set(userId, user?.name ?? user?.email ?? null);
  }
  return names.get(userId) ?? null;
}

export function recordActivity(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const path = req.path;
  res.on('finish', () => {
    if (res.statusCode >= 300) return;
    const auth = res.locals.auth as AuthToken | undefined;
    const described = describeRequest(req.method, path);
    if (!auth || !described) return;
    void (async () => {
      await ActivityLog.create({
        ...described,
        actorId: auth.userId,
        actorName: await actorName(auth.userId),
        method: req.method,
        path,
      });
    })().catch((err) => logger.warn({ err, path }, 'could not record activity'));
  });
  next();
}
