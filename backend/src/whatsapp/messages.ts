import { formatLocal, toBusinessLocal } from '../lib/time.js';

/**
 * Everything the bot says, in one place.
 *
 * Kept out of the machine deliberately: transitions are logic worth testing,
 * copy is text worth changing without touching logic. It is also where the
 * pilot's tone gets adjusted after real customers read it.
 *
 * House rules: numbered lists so a reply is one keystroke; times always
 * business-local; prices in rupees, never paisa; no emoji beyond one greeting.
 */

/** Minor units are paisa — never show them, and never do money in floats. */
export function formatPrice(priceMinor: number): string {
  return `Rs ${Math.round(priceMinor / 100).toLocaleString('en-PK')}`;
}

export function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

export const greeting = (businessName: string, firstName: string | null) =>
  firstName
    ? `Welcome back to ${businessName}, ${firstName} 👋`
    : `Welcome to ${businessName} 👋`;

export const serviceMenu = (
  services: { name: string; durationMinutes: number; priceMinor: number }[],
) =>
  `What would you like to book?\n\n${numbered(
    services.map((s) => `${s.name} — ${s.durationMinutes} min, ${formatPrice(s.priceMinor)}`),
  )}\n\nReply with a number.`;

export const staffMenu = (names: string[]) =>
  `Who would you like to see?\n\n${numbered([...names, 'No preference'])}\n\nReply with a number.`;

export const dateMenu = (dates: string[], timezone: string) =>
  `Which day suits you?\n\n${numbered(
    dates.map((date) => toBusinessLocal(new Date(`${date}T12:00:00Z`), timezone).toFormat('cccc d LLLL')),
  )}\n\nReply with a number.`;

export const slotMenu = (slots: Date[], timezone: string) =>
  `Available times:\n\n${numbered(
    slots.map((slot) => formatLocal(slot, timezone, 'h:mm a')),
  )}\n\nReply with a number.`;

export const confirmation = (details: {
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  priceMinor: number;
}) =>
  `Please confirm:\n\n` +
  `${details.serviceName}\n` +
  `with ${details.staffName}\n` +
  `${formatLocal(details.startsAt, details.timezone)}\n` +
  `${formatPrice(details.priceMinor)}\n\n` +
  `Reply YES to confirm or NO to pick another time.`;

export const booked = (details: {
  businessName: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
}) =>
  `You're booked ✅\n\n` +
  `${details.serviceName} with ${details.staffName}\n` +
  `${formatLocal(details.startsAt, details.timezone)}\n\n` +
  `See you at ${details.businessName}. Reply CANCEL or RESCHEDULE any time.`;

/**
 * The reminder.
 *
 * Deliberately shorter than the confirmation and deliberately re-states the
 * time: it arrives a day later into a chat the customer has scrolled past, so
 * anything that assumes they can see the confirmation above it is a message that
 * only makes sense to whoever wrote it.
 *
 * CANCEL and RESCHEDULE are offered again for the same reason a reminder exists
 * at all — the point is not to be polite, it is to convert a no-show into a
 * freed slot the owner can still sell.
 */
export const reminder = (details: {
  businessName: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  /** Whether the appointment is on the customer's "tomorrow" or later today. */
  sameDay: boolean;
}) =>
  `Reminder: ${details.serviceName} ${details.sameDay ? 'today' : ''}`.trimEnd() +
  `\n${formatLocal(details.startsAt, details.timezone)}\n` +
  `with ${details.staffName} at ${details.businessName}\n\n` +
  `Reply CANCEL or RESCHEDULE if you can't make it.`;

/**
 * Losing the race is normal traffic on a busy Saturday, so this reads as an
 * ordinary thing that happened, not an error the customer caused.
 */
export const slotTaken = 'Sorry — that time just went. Here are the next available times:';

export const nothingAvailable = (serviceName: string) =>
  `Sorry, there's nothing available for ${serviceName} at the moment. ` +
  `Reply HELP and someone will get back to you.`;

export const invalidInput = 'Sorry, I didn\'t catch that. Reply with one of the numbers above.';

export const tooManyInvalid = (businessName: string) =>
  `Sorry, I'm not following. Reply HELP and someone from ${businessName} will message you directly.`;

export const helpRequested = 'Thanks — someone will get back to you shortly.';

export const optedOut =
  "You won't receive any more offers from us. " +
  "You'll still get confirmations and reminders for appointments you book. Reply START to opt back in.";

export const optedIn = "You're back on the list. Reply STOP any time to opt out again.";

export const nothingToCancel = 'You don\'t have any upcoming appointments.';

export const cancelPrompt = (details: { serviceName: string; startsAt: Date; timezone: string }) =>
  `Cancel ${details.serviceName} on ${formatLocal(details.startsAt, details.timezone)}?\n\n` +
  `Reply YES to cancel or NO to keep it.`;

export const cancelled = 'Your appointment has been cancelled.';

export const cancelKept = 'No problem — your appointment is unchanged.';

export const upcomingMenu = (
  bookings: { serviceName: string; startsAt: Date }[],
  timezone: string,
) =>
  `Which appointment?\n\n${numbered(
    bookings.map((b) => `${b.serviceName} — ${formatLocal(b.startsAt, timezone)}`),
  )}\n\nReply with a number.`;

export const ratingThanks = 'Thanks for the feedback!';
