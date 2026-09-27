import { BRIEFING_TEXT_MAX } from '@scalivo/shared';
import { generate } from '../lib/gemini.js';
import { logger } from '../lib/logger.js';

/**
 * Gemini, on a very short leash — SPEC §11.1's reasoning layer, the half that is
 * not rules.
 *
 * The model is given prose that is already correct and asked to say the same
 * thing better. It is not asked what is true, what matters, or what to do. This
 * is a deliberate narrowing of what an LLM is for, and it buys three things that
 * matter more than sounding clever:
 *
 * 1. **It cannot be wrong about the business.** The numbers were computed by
 *    `facts.ts` and the template already spent them; there is no question here
 *    whose answer the model could get wrong.
 * 2. **The failure mode is "plainer wording".** Timeout, quota, outage, malformed
 *    response, missing key — every one of them returns null and the template goes
 *    out unchanged. SPEC §11.3: never block the briefing on the LLM.
 * 3. **The one remaining risk is checkable.** A rewrite could still mangle a
 *    figure, and that is the one error an owner would act on. So the numbers in
 *    the rewrite are compared against the numbers in the original and a rewrite
 *    that changed any of them is thrown away (`sameNumbers` below). That check is
 *    mechanical, which is the point — "we asked it not to" is not a safeguard.
 *
 * Worth being plain in the thesis: this is a phrasing layer. Calling it
 * autonomous reasoning would be a claim the code does not support.
 */

/** Long enough for a rewrite, short enough that nobody waits for a briefing. */
const TIMEOUT_MS = 8_000;

/**
 * The instruction. Constrained deliberately: what it may change, what it may not,
 * and how long it has to be.
 *
 * "Do not add advice" is there because an LLM asked to improve a business summary
 * will reliably invent a recommendation, and a recommendation that is not backed
 * by a rule in `thresholds.ts` is the agent making things up in the one voice the
 * owner is inclined to trust.
 */
const INSTRUCTION = [
  'You rewrite short business updates for the owner of a small salon or gym in Pakistan.',
  'Rewrite the update below so it reads naturally and warmly, as one short paragraph.',
  'Rules, all of them absolute:',
  '- Keep every number, name, date, time and money amount EXACTLY as written. Do not round, convert, recalculate or drop any of them.',
  '- Do not add any fact, number, advice or suggestion that is not already in the update.',
  '- Do not add a greeting, a sign-off, emoji, or markdown formatting.',
  '- Keep it under 60 words. Plain English.',
  'Reply with the rewritten paragraph only.',
].join('\n');

/**
 * Rewrite one briefing body, or return null and let the template stand.
 *
 * Null is an ordinary outcome and is never logged as an error unless something
 * genuinely unexpected happened — a business with no Gemini key configured must
 * not produce a warning every morning forever.
 */
export async function rephrase(body: string): Promise<string | null> {
  const text = await generate({
    instruction: INSTRUCTION,
    input: body,
    // Low but not zero: the job is a natural rewrite, and a deterministic one
    // reads like a thesaurus was applied to the template.
    temperature: 0.4,
    maxOutputTokens: 300,
    timeoutMs: TIMEOUT_MS,
    purpose: 'briefing',
  });

  // No key, a timeout, a refusal — all of them mean the same thing here, and the
  // template that goes out instead was already correct.
  if (text === null) return null;

  return clean(text, body);
}

/**
 * Accept the rewrite only if it is safe to show.
 *
 * Every rejection here falls back to prose that was already correct, so this can
 * afford to be strict. It refuses anything empty, anything over-long, and —
 * the one that matters — anything whose numbers do not match.
 */
function clean(raw: string, original: string): string | null {
  const text = raw
    // Models reach for markdown even when told not to. Stripping is kinder than
    // rejecting, since the words themselves are usually fine.
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 20) return null;
  if (text.length > BRIEFING_TEXT_MAX) return null;

  if (!sameNumbers(original, text)) {
    logger.warn(
      { original, rewrite: text },
      'gemini changed a figure — rejected, using the plain briefing',
    );
    return null;
  }

  return text;
}

/**
 * Do two texts contain the same numbers, as a multiset?
 *
 * A multiset rather than a set, so "3 appointments and 3 no-shows" cannot quietly
 * become "3 appointments and 8 no-shows" by reusing a number that is present
 * elsewhere. Thousands separators and decimal points are normalised first,
 * because "Rs 12,500" and "Rs 12500" are the same figure and a rewrite that
 * reformats one is not the failure this is looking for.
 *
 * Deliberately blind to word order: the rewrite is allowed to move a figure to a
 * different sentence, it is just not allowed to change it.
 */
export function sameNumbers(a: string, b: string): boolean {
  const numbers = (text: string) =>
    (text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [])
      // Trailing-zero forms of the same value are equal: 3.0 and 3 are one figure.
      .map((value) => String(Number(value)))
      .sort();

  const left = numbers(a);
  const right = numbers(b);

  return left.length === right.length && left.every((value, i) => value === right[i]);
}
