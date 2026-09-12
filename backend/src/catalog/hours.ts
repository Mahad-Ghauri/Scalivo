import { z } from 'zod';

/**
 * Working-hours validation.
 *
 * Every rule here exists because breaking it produces NO ERROR ANYWHERE — just
 * an empty availability list, which is indistinguishable from a fully booked
 * day. An owner would set their hours, see no slots, and have nothing to go on.
 *
 * The three that actually bite, all traceable to getAvailability():
 *
 *   1. closesAt <= opensAt. Availability resolves both against the SAME
 *      calendar date, so an overnight day gives closes < opens and the grid
 *      loop never executes a single iteration. Zero slots, silently.
 *
 *   2. A duplicate dayOfWeek. Availability picks hours with `.find()`, so the
 *      second Tuesday is simply never read. The owner's later edit is the one
 *      that disappears, which is the worse half of the bug.
 *
 *   3. A break spanning the whole day, or sitting outside opening hours. Not
 *      fatal, but it means something the owner did not intend, and they will
 *      read it as the system losing their input.
 *
 * Rule 1 is a refusal rather than a fix because the honest options are to
 * support midnight crossing in the grid or to reject it, and quietly snapping
 * 02:00 to 23:59 would be neither.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const time = z.string().regex(TIME_PATTERN, 'expected HH:MM in 24-hour form');

/** Minutes past local midnight. Only ever compared against another of these. */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

const breakSchema = z.object({ startsAt: time, endsAt: time });

const daySchema = z.object({
  /** 0 = Sunday, matching luxon's `weekday % 7` in availability.ts. */
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: time,
  closesAt: time,
  breaks: z.array(breakSchema).max(6).default([]),
});

export const workingHoursSchema = z
  .array(daySchema)
  .max(7, 'a week has seven days')
  .superRefine((days, ctx) => {
    const seen = new Set<number>();

    days.forEach((day, index) => {
      const at = (field: string) => ({ path: [index, field] as (string | number)[] });

      if (seen.has(day.dayOfWeek)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'that day is listed twice — put both spans in one entry with a break between',
          ...at('dayOfWeek'),
        });
      }
      seen.add(day.dayOfWeek);

      const opens = minutesOfDay(day.opensAt);
      const closes = minutesOfDay(day.closesAt);

      if (closes <= opens) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'closing must be after opening — hours that cross midnight are not supported yet',
          ...at('closesAt'),
        });
        return; // the break checks below are meaningless against an invalid span
      }

      const spans = day.breaks
        .map((b) => ({ start: minutesOfDay(b.startsAt), end: minutesOfDay(b.endsAt) }))
        .sort((a, b) => a.start - b.start);

      spans.forEach((span, i) => {
        if (span.end <= span.start) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'a break must end after it starts',
            ...at('breaks'),
          });
          return;
        }
        if (span.start < opens || span.end > closes) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'a break has to sit inside opening hours',
            ...at('breaks'),
          });
          return;
        }
        const previous = spans[i - 1];
        if (previous && span.start < previous.end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'two breaks overlap',
            ...at('breaks'),
          });
        }
      });
    });
  });

export type WorkingHoursInput = z.infer<typeof workingHoursSchema>;
