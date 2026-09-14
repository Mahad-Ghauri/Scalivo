/**
 * Getting an owner-typed phone number into the same shape WhatsApp uses.
 *
 * WhatsApp hands us `923209263011` — E.164 without the '+'. An owner typing the
 * same customer into the calendar types `0320 926 3011`, because that is what is
 * written on the card in front of them. Store that verbatim and the two never
 * match: the walk-in gets a second Client, a second CRM profile, and the visit
 * history splits in half with nothing to show that it happened. No error, no log
 * line — just a regular who looks like a stranger.
 *
 * Conversion is deliberately narrow. Only the two Pakistani spellings that are
 * unambiguous are rewritten; anything else is passed through digits-only rather
 * than guessed at, because inventing a country code is worse than storing an
 * unmatched number.
 */

/** Pakistan. The only country the pilot serves, and the only prefix assumed. */
const PK = '92';

export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // 03209263011 — the national form, as printed on every Pakistani shopfront.
  if (digits.length === 11 && digits.startsWith('03')) return PK + digits.slice(1);

  // 3209263011 — the same number with the trunk '0' already dropped.
  if (digits.length === 10 && digits.startsWith('3')) return PK + digits;

  // Already international, with or without a leading '+' we have just stripped.
  // Includes 92… as it stands, and any other country typed in full.
  if (digits.length >= 8) return digits;

  // Too short to be a mobile number anywhere. Refuse rather than store a stub
  // that will never match an inbound message.
  return null;
}
