import {
  SESSION_STATUS,
  SETUP_STEP,
  type SetupChecklist,
  type SetupStep,
  type SetupStepId,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';

/**
 * What still stands between a registered business and a real booking.
 *
 * This module exists because of one property of getAvailability(): every
 * misconfiguration below returns an empty slot list, and an empty slot list is
 * exactly what a fully booked day returns. There is no error, no log line, and
 * nothing an owner could act on — they would see a working app that simply
 * never produces a booking.
 *
 * The coverage step is the one worth reading twice. Availability filters staff
 * by `serviceIds: serviceId` and returns [] when none match, so a service
 * nobody is assigned to still appears in the WhatsApp menu, still accepts a
 * tap, and then dead-ends on "no times available". The customer concludes the
 * salon is full. Nothing distinguishes it from a genuinely full diary except
 * this check.
 */

function step(id: SetupStepId, done: boolean, detail: string): SetupStep {
  return { id, done, detail: done ? null : detail };
}

export async function setupChecklist(businessId: string): Promise<SetupChecklist> {
  const [business, services, staff] = await Promise.all([
    Business.findById(businessId),
    Service.find({ businessId, active: true }).select('_id name'),
    Staff.find({ businessId, active: true }).select('_id name serviceIds workingHours'),
  ]);

  // Someone with hours is the only kind of staff availability can ever offer.
  const staffed = staff.filter((s) => s.workingHours.length > 0);

  // Which active services have nobody qualified AND working. Both conditions
  // matter: a service assigned only to someone with no hours is as unbookable
  // as one assigned to nobody.
  const covers = new Set<string>();
  for (const member of staffed) for (const id of member.serviceIds) covers.add(id);
  const uncovered = services.filter((s) => !covers.has(String(s._id)));

  const session = business?.whatsapp;
  const linked = Boolean(session?.sessionId);
  const ready = linked && session?.status === SESSION_STATUS.READY;

  const steps: SetupStep[] = [
    step(SETUP_STEP.SERVICES, services.length > 0, 'Add at least one service customers can book'),
    step(SETUP_STEP.STAFF, staff.length > 0, 'Add at least one person who takes appointments'),
    step(
      SETUP_STEP.HOURS,
      staffed.length > 0,
      'Set working hours — without them nobody has any bookable time',
    ),
    step(
      SETUP_STEP.COVERAGE,
      // Vacuously true with no services: the services step is already the
      // complaint, and reporting the same gap twice reads as two problems.
      services.length === 0 || uncovered.length === 0,
      uncovered.length > 0
        ? `Nobody can perform: ${uncovered.map((s) => s.name).join(', ')}`
        : 'Assign each service to someone who can perform it',
    ),
    step(
      SETUP_STEP.WHATSAPP,
      ready,
      linked ? 'Scan the QR code to connect WhatsApp' : 'Connect a WhatsApp number',
    ),
  ];

  return { bookable: steps.every((s) => s.done), steps };
}
