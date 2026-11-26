import { formatLocal, toBusinessLocal } from '../lib/time.js';

/**
 * Everything the bot says, in one place.
 *
 * Kept out of the machine deliberately: transitions are logic worth testing,
 * copy is text worth changing without touching logic. It is also where the
 * pilot's tone gets adjusted after real customers read it.
 *
 * House rules: conversational booking questions; times always
 * business-local; prices in rupees, never paisa; no emoji beyond one greeting.
 */

/** Minor units are paisa — never show them, and never do money in floats. */
export function formatPrice(priceMinor: number): string {
  return `Rs ${Math.round(priceMinor / 100).toLocaleString('en-PK')}`;
}

export function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

const listed = (items: string[]): string => items.slice(0, 20).map((item) => `• ${item}`).join('\n').slice(0, 3000);

export const bookingHelp = 'I can help with services, prices, working hours, available times, and your appointments. Tell me what you need, or ask to speak to someone.';
export const availabilityNeedsService = 'Which service do you need? Available times depend on the service.';
export const nothingToMove = 'You have no upcoming appointment to reschedule. Would you like to book one?';
export const noAppointments = 'You have no upcoming appointments. Would you like to book one?';
export const location = (parts: string[]) => parts.length ? `Our listed location: ${parts.join(', ')}.`
  : 'The address is not listed yet. Ask to speak to someone for directions.';
export const serviceDetails = (services: { name: string; durationMinutes: number; priceMinor: number }[]) =>
  services.length ? `Here are our services:\n\n${listed(services.map((service) => `${service.name} — ${service.durationMinutes} min, ${formatPrice(service.priceMinor)}`))}`
    : 'That service is not listed. Ask to speak to someone for more information.';
export const staffDetails = (names: string[]) => names.length
  ? `You can book with:\n\n${listed(names)}\n\nWho would you prefer? You can also say anyone.`
  : 'No bookable staff are listed. Ask to speak to someone.';
export const workingHours = (members: { name: string; hours: { dayOfWeek?: number; opensAt?: string; closesAt?: string }[] }[]) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hours = members.flatMap((member) => member.hours.filter((hour) =>
    hour.dayOfWeek !== undefined && Number.isInteger(hour.dayOfWeek) && hour.dayOfWeek >= 0 && hour.dayOfWeek <= 6 && hour.opensAt && hour.closesAt,
  ).map((hour) => `${member.name}: ${days[hour.dayOfWeek!]} ${hour.opensAt}–${hour.closesAt}`));
  return hours.length ? `Bookable working hours:\n\n${listed(hours)}\n\nWhich service and day would you like?`
    : 'Working hours are not listed yet. Ask to speak to someone.';
};
export const appointmentList = (bookings: { serviceName: string; startsAt: Date }[], timezone: string) =>
  `Your upcoming appointments:\n\n${listed(bookings.map((booking) => `${booking.serviceName} — ${formatLocal(booking.startsAt, timezone)}`))}\n\nYou can ask to cancel or reschedule an appointment.`;

export const greeting = (businessName: string, firstName: string | null) =>
  firstName
    ? `Welcome back to ${businessName}, ${firstName} 👋`
    : `Welcome to ${businessName} 👋`;

export const serviceMenu = (
  services: { name: string; durationMinutes: number; priceMinor: number }[],
) =>
  `What would you like to book?\n\n${listed(
    services.map((s) => `${s.name} — ${s.durationMinutes} min, ${formatPrice(s.priceMinor)}`),
  )}\n\nTell us the service you'd like and when you want to come.`;

export const staffMenu = (names: string[]) =>
  `Who would you like to see?\n\n${listed([...names, 'No preference'])}\n\nTell us their name, or say anyone.`;

export const dateMenu = (dates: string[], timezone: string) =>
  `Which day suits you?\n\n${listed(
    dates.map((date) => toBusinessLocal(new Date(`${date}T12:00:00Z`), timezone).toFormat('cccc d LLLL')),
  )}\n\nTell us a day, such as tomorrow.`;

/** At most one day of five-minute starts; selection options use the same cap. */
export const MAX_SLOT_OPTIONS = 288;

export const slotMenu = (slots: Date[], timezone: string) => {
  const shown = slots.slice(0, MAX_SLOT_OPTIONS);
  const more = slots.length > shown.length
    ? `\n\nShowing the first ${shown.length} times. You can ask about later times.` : '';
  return `Available times:\n\n${shown.map((slot) => `• ${formatLocal(slot, timezone, 'h:mm a')}`).join('\n')}${more}` +
    '\n\nWhat time suits you? You can say a time, such as 3pm, or ask for another day.';
};

/**
 * What we understood from a sentence, said back before anything is held — the
 * free-text path's first line (milestone 3.2).
 *
 * This is not politeness. A parse can be wrong in ways the customer cannot see:
 * "facial" at a salon with three of them, a Saturday that was meant to be next
 * Saturday. Echoing the interpretation puts it in front of them at the point where
 * correcting it costs one message, rather than at the confirmation where they have
 * already spent three. Anything the parse did NOT establish is simply absent, so
 * the line never implies a choice the customer did not make.
 */
export const understood = (details: {
  serviceName: string | null;
  staffName: string | null;
  date: string | null;
  windowLabel: string | null;
  timezone: string;
}) => {
  const parts = [
    details.serviceName,
    details.staffName ? `with ${details.staffName}` : null,
    details.date
      ? toBusinessLocal(new Date(`${details.date}T12:00:00Z`), details.timezone).toFormat('cccc d LLLL')
      : null,
    details.windowLabel,
  ].filter((part): part is string => part !== null);

  return `Got it — ${parts.join(', ')}.`;
};

/**
 * The time of day they asked for has nothing free.
 *
 * Says so rather than silently widening: a customer who asked for the afternoon and
 * is shown a 10am slot without explanation reads it as the bot ignoring them. The
 * filter is dropped at the same time, so the rest of the conversation stops
 * promising a window that does not exist.
 */
export const nothingInWindow = (windowLabel: string) =>
  `Nothing free ${windowLabel} — here's the rest of the day:`;

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

/**
 * `pageUrl` is the customer's own page (3.3), and it is on EVERY confirmation
 * rather than only the first — deliberately.
 *
 * The token behind it never expires (me/token.ts), which means there is no
 * re-issue flow and a customer who deletes the message has lost the link for
 * good. Repeating it is therefore the recovery mechanism: the most recent
 * confirmation always carries a working URL. The alternative — an unprompted
 * "here is your link" message — is exactly the cold outbound that risks the
 * number (NOTES.md).
 *
 * Null when the page could not be addressed. The confirmation is transactional
 * and must never be lost because a convenience link could not be minted.
 */
export const booked = (details: {
  businessName: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  pageUrl?: string | null;
}) =>
  `You're booked ✅\n\n` +
  `${details.serviceName} with ${details.staffName}\n` +
  `${formatLocal(details.startsAt, details.timezone)}\n\n` +
  `See you at ${details.businessName}. Reply CANCEL or RESCHEDULE any time.` +
  (details.pageUrl ? `\n\nYour appointments: ${details.pageUrl}` : '');

/**
 * The deposit ask, sent INSTEAD of "you're booked".
 *
 * It must not read like a confirmation. The slot is held, not booked, and a
 * customer who skims "Hydrafacial, Saturday 4pm" and stops reading will turn
 * up to an appointment that expired. So the first line says what is missing,
 * and the deadline is a clock time rather than "30 minutes", because the
 * message may be read long after it was sent.
 */
export const depositRequest = (details: {
  businessName: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  depositMinor: number;
  dueBy: Date;
  payUrl: string;
}) =>
  `Almost booked — a deposit of ${formatPrice(details.depositMinor)} secures your slot.\n\n` +
  `${details.serviceName} with ${details.staffName}\n` +
  `${formatLocal(details.startsAt, details.timezone)}\n\n` +
  `Pay here: ${details.payUrl}\n\n` +
  `We'll hold it until ${formatLocal(details.dueBy, details.timezone, 'h:mm a')}. ` +
  `The deposit comes off your bill at ${details.businessName}.`;

export const depositExpired = (details: {
  serviceName: string;
  startsAt: Date;
  timezone: string;
}) =>
  `We didn't receive the deposit in time, so the ${details.serviceName} slot on ` +
  `${formatLocal(details.startsAt, details.timezone)} has been released.\n\n` +
  `Message us any time to book again.`;

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
  /** Already confirmed by an earlier reminder: don't ask again, just remind. */
  alreadyConfirmed?: boolean;
}) =>
  `Reminder: ${details.serviceName} ${details.sameDay ? 'today' : ''}`.trimEnd() +
  `\n${formatLocal(details.startsAt, details.timezone)}\n` +
  `with ${details.staffName} at ${details.businessName}\n\n` +
  (details.alreadyConfirmed
    ? `You're confirmed ✅\nReply 2 to reschedule or 3 to cancel if plans change.`
    : `Reply 1 to confirm · 2 to reschedule · 3 to cancel`);

export const reminderConfirmed = (details: { startsAt: Date; timezone: string }) =>
  `Thanks, you're confirmed ✅ See you ${formatLocal(details.startsAt, details.timezone)}.`;

/**
 * The follow-up offer. Leads with the reason (the owner's note, or the service)
 * because it arrives weeks after the last message in this chat, and names a
 * concrete slot so "1" is a whole booking, not the start of a menu.
 */
export const followUpOffer = (d: {
  businessName: string;
  serviceName: string;
  note: string | null;
  dueAt: Date;
  timezone: string;
  slot: { startsAt: Date; staffName: string } | null;
  nudge: boolean;
}) =>
  (d.nudge ? `Just checking in from ${d.businessName} 🙂\n` : `Hi from ${d.businessName}!\n`) +
  `Your follow-up ${d.serviceName} is due around ${formatLocal(d.dueAt, d.timezone, 'ccc d LLL')}.` +
  (d.note ? `\n${d.note}` : '') +
  '\n\n' +
  (d.slot
    ? `Want ${formatLocal(d.slot.startsAt, d.timezone)} with ${d.slot.staffName}?\n\n` +
      `Reply 1 to book it · 2 for other times · 3 for not now`
    : `Reply 1 to pick a time · 3 for not now`);

export const followUpDeclined =
  "No problem — we won't remind you about this one. Send HI whenever you'd like to book.";

/** The reply arrived after the owner cancelled/moved it, or after it started. */
export const reminderBookingGone =
  "That appointment is no longer upcoming. Send HI if you'd like to book a new one.";

/**
 * Losing the race is normal traffic on a busy Saturday, so this reads as an
 * ordinary thing that happened, not an error the customer caused.
 */
export const slotTaken = 'Sorry — that time just went. Here are the next available times:';

export const nothingAvailable = (serviceName: string) =>
  `Sorry, there's nothing available for ${serviceName} at the moment. ` +
  `Reply HELP and someone will get back to you.`;

export const invalidInput = "Sorry, I didn't catch that.";

/** An opener that is not a greeting or a booking word. The menu follows it. */
export const notUnderstood = "Sorry, I didn't understand that.";

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

/** Sent after `cancelled`. Staff is named only when they can still take the booking. */
export const rebookOffer = (details: { serviceName: string; staffName: string | null }) =>
  `Would you like to book ${details.serviceName}` +
  `${details.staffName ? ` with ${details.staffName}` : ''} on another day?\n\n` +
  `${numbered(['Yes', 'No'])}\n\nReply with a number.`;

export const rebookDeclined = 'No problem. Message us any time to book again.';

export const cancelKept = 'No problem — your appointment is unchanged.';

export const upcomingMenu = (
  bookings: { serviceName: string; startsAt: Date }[],
  timezone: string,
) =>
  `Which appointment?\n\n${numbered(
    bookings.map((b) => `${b.serviceName} — ${formatLocal(b.startsAt, timezone)}`),
  )}\n\nReply with a number.`;

/**
 * The rating request. One message, one keystroke to answer.
 *
 * No link and no form on purpose — SPEC §9 exists because every other review
 * mechanism asks the customer to leave WhatsApp, and almost nobody does. The
 * cost of that convenience is the ambiguity of a bare `4`, which the
 * pending-prompt interceptor pays for us.
 */
export const ratingRequest = (details: { businessName: string; serviceName: string }) =>
  `Thanks for coming in to ${details.businessName}! How was your ${details.serviceName}?\n\n` +
  `Reply with a number from 1 to 5 — 5 is excellent.`;

export const ratingThanks = 'Thanks for the feedback!';

/**
 * Asked only of the customers whose rating will be published.
 *
 * The opt-out is spelled out because the alternative — silence — leaves someone
 * who has nothing to add stuck at a question, and their next message would be
 * read as the comment.
 */
export const reviewCommentPrompt =
  'Glad to hear it! Would you like to add a few words for our profile?\n\n' +
  'Reply with your comment, or SKIP.';

export const reviewPublished = 'Thank you — your review is now on our profile.';

/**
 * What a 1–3 hears. Deliberately identical in warmth to the 4–5 path and
 * deliberately silent about the owner alert: SPEC §9.1 says the flag is
 * private, and telling the customer "we've reported this internally" invites
 * the escalation the private path exists to avoid.
 */
export const ratingNoted =
  "Thanks for telling us — sorry it wasn't better. We'll look into it.";

/**
 * Retention — SPEC §6. The only messages here that nobody asked for, which is
 * why they are the only ones that carry an opt-out line.
 */

/**
 * The line every marketing message ends with.
 *
 * Not decoration and not a legal reflex: `STOP` is already honoured by the
 * interceptor chain from any state, so this is simply telling the customer about
 * a control that exists. A marketing message without it is one the recipient can
 * only escape by blocking the number — and a blocked number stops delivering
 * appointment reminders too.
 */
export const optOutLine = 'Reply STOP to stop these messages.';

/**
 * "It's been a while" — §6.1.
 *
 * Names the service they actually had, because that is the whole difference
 * between this and a mailshot: the customer can tell it was written about them.
 * BOOK rather than a number, since a bare digit from an idle conversation is an
 * opener that lands on the service menu — the word gets them the same menu and
 * reads like an instruction instead of a guess.
 *
 * The gap is given in whole weeks. "It's been 37 days" is a database talking.
 */
export const rebookNudge = (details: {
  firstName: string | null;
  businessName: string;
  serviceName: string | null;
  weeksSince: number;
}) => {
  const hello = details.firstName ? `Hi ${details.firstName}` : 'Hi';
  const what = details.serviceName ? `your ${details.serviceName}` : 'your last visit';
  const when =
    details.weeksSince <= 1 ? 'a week' : details.weeksSince >= 8 ? 'a while' : `${details.weeksSince} weeks`;

  return (
    `${hello} — it's been ${when} since ${what} at ${details.businessName}. ` +
    `Would you like to book your next one?\n\n` +
    `Reply BOOK and I'll show you what's free.\n\n${optOutLine}`
  );
};

/**
 * The broadcast the owner is offered before they write their own — §6.2.
 *
 * A default rather than a blank box, because the owner this is built for has
 * never written a marketing message and a blank box is where the feature stops
 * being used. It says nothing that is not true of every business here, and it
 * invents no offer: a discount is the owner's decision to make, not a template's.
 */
export const campaignTemplate = (businessName: string) =>
  `We haven't seen you at ${businessName} in a while — we'd love to have you back. ` +
  `Reply BOOK and I'll show you what's free this week.`;

/** An owner's message, with the opt-out line added if they have not written one. */
export const campaignMessage = (body: string) =>
  /\bstop\b/i.test(body) ? body.trim() : `${body.trim()}\n\n${optOutLine}`;

export const clarifyTime = 'Please give one exact time with AM or PM, such as 5:30 PM. I have not booked a time.';
export const requestedTimeUnavailable = 'That exact time is not available. Please choose another time; I have not booked anything.';

export const neitherTimeAvailable = 'Neither the AM nor PM time is available. Please choose another time; I have not booked anything.';
export const ambiguousTimeOptions = (slots: Date[], timezone: string) =>
  `At that time, ${slots.length === 1 ? 'only this option is available' : 'these options are available'}:\n\n` +
  slots.map((slot) => `• ${formatLocal(slot, timezone, 'h:mm a')}`).join('\n') +
  '\n\nPlease specify the time with AM or PM. I have not booked anything.';

export const bookingRequestNotUnderstood = 'I could not understand the full booking request. Please send the service and day again, or reply with just a time such as 3:00 PM. I have not booked anything.';
