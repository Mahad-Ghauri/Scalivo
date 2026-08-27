import { describe, expect, it } from 'vitest';
import {
  alignToGrid,
  businessDayBounds,
  formatLocal,
  occupiedSlots,
  wallClockToUtc,
} from '../src/lib/time.js';

const PKT = 'Asia/Karachi';

describe('time handling', () => {
  /**
   * The Phase 0 definition of done: a booking created at 4pm PKT reads back as
   * 4pm regardless of server timezone. Run under TZ=UTC and
   * TZ=America/New_York — if either fails, every reminder and no-show statistic
   * downstream is wrong.
   */
  it('round-trips 4pm PKT independent of server timezone', () => {
    const utc = wallClockToUtc('2026-09-05T16:00', PKT);

    // PKT is UTC+5 with no DST, so 4pm local is 11:00Z.
    expect(utc.toISOString()).toBe('2026-09-05T11:00:00.000Z');
    expect(formatLocal(utc, PKT, 'HH:mm')).toBe('16:00');
  });

  it('computes day bounds on the business local day, not the server day', () => {
    const { start, end } = businessDayBounds('2026-09-05', PKT);

    // The PKT day starts at 19:00Z the previous day. A server-local boundary
    // would misattribute every booking in the first five hours.
    expect(start.toISOString()).toBe('2026-09-04T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-05T19:00:00.000Z');
  });

  it('rejects invalid wall-clock input instead of silently coercing', () => {
    expect(() => wallClockToUtc('not-a-time', PKT)).toThrow(/Invalid wall-clock/);
    expect(() => wallClockToUtc('2026-09-05T16:00', 'Mars/Olympus')).toThrow(/Invalid wall-clock/);
  });
});

describe('slot grid', () => {
  it('expands a 45-min service into three 15-min occupancy points', () => {
    const start = wallClockToUtc('2026-09-05T16:00', PKT);
    const slots = occupiedSlots(start, 45, 15);

    expect(slots.map((s) => formatLocal(s, PKT, 'HH:mm'))).toEqual(['16:00', '16:15', '16:30']);
  });

  it('rounds a partial increment up so the tail of a service is still held', () => {
    // A 20-min service on a 15-min grid occupies 16:00 and 16:15 — otherwise
    // something could be booked at 16:15 while the first service is still running.
    const start = wallClockToUtc('2026-09-05T16:00', PKT);
    expect(occupiedSlots(start, 20, 15)).toHaveLength(2);
  });

  it('aligns off-grid starts down to the grid', () => {
    const offGrid = wallClockToUtc('2026-09-05T16:07', PKT);
    expect(formatLocal(alignToGrid(offGrid, 15), PKT, 'HH:mm')).toBe('16:00');
  });

  /**
   * The overlap case the docs' original {businessId, staffId, startsAt} index
   * would miss entirely: different start times, same staff, overlapping work.
   * Here they must share at least one grid point so the unique index collides.
   */
  it('makes overlapping services collide on at least one grid point', () => {
    const facial = occupiedSlots(wallClockToUtc('2026-09-05T16:00', PKT), 45, 15);
    const laser = occupiedSlots(wallClockToUtc('2026-09-05T16:15', PKT), 20, 15);

    const shared = facial.filter((f) => laser.some((l) => l.getTime() === f.getTime()));
    expect(shared.length).toBeGreaterThan(0);
  });
});
