import { type CalendarDay } from '@scalivo/shared';

/**
 * All date math relies on parsing YYYY-MM-DD as UTC noon (T12:00:00Z).
 * This safely avoids timezone edge cases that would push midnight to the previous or next day.
 */

export function parseLocalAsUtcNoon(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`);
}

export function formatUtcNoonAsLocal(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

export function addDays(dateStr: string, days: number): string {
  const date = parseLocalAsUtcNoon(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcNoonAsLocal(date);
}

/** Assumes Monday is the start of the week */
export function getWeekStart(dateStr: string): string {
  const date = parseLocalAsUtcNoon(dateStr);
  const day = date.getUTCDay(); // Sunday = 0, Monday = 1
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return formatUtcNoonAsLocal(date);
}

/** Generates a sequence of N dates starting from dateStr */
export function generateDateSequence(startDateStr: string, days: number): string[] {
  const seq: string[] = [];
  for (let i = 0; i < days; i++) {
    seq.push(addDays(startDateStr, i));
  }
  return seq;
}

/**
 * Extracts the local hour and minute (0-23 and 0-59) from a UTC instant, 
 * using the business's timezone. This completely avoids manual offset parsing.
 */
export function getLocalTimeParts(instant: string | Date, timezone: string): { hour: number; minute: number } {
  const d = new Date(instant);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23', // 0-23
  });
  
  const parts = formatter.formatToParts(d);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  
  return { hour, minute };
}

/**
 * Calculates the dynamic visual bounds of the grid (earliest start hour, latest end hour).
 * Minimum bounds are 09:00 to 17:00 if completely empty.
 */
export function getGridBounds(days: CalendarDay[], timezone: string): { minHour: number; maxHour: number } {
  let min = 9;
  let max = 17;
  
  for (const day of days) {
    for (const entry of day.entries) {
      const startParts = getLocalTimeParts(entry.startsAt, timezone);
      const endParts = getLocalTimeParts(entry.endsAt, timezone);
      
      const startHour = startParts.hour;
      // Round end up to the next hour if there's a spillover
      const endHour = endParts.minute > 0 ? endParts.hour + 1 : endParts.hour;
      
      if (startHour < min) min = startHour;
      if (endHour > max) max = endHour;
    }
    
    for (const block of day.blocks) {
      const startParts = getLocalTimeParts(block.startsAt, timezone);
      const endParts = getLocalTimeParts(block.endsAt, timezone);
      const startHour = startParts.hour;
      const endHour = endParts.minute > 0 ? endParts.hour + 1 : endParts.hour;
      if (startHour < min) min = startHour;
      if (endHour > max) max = endHour;
    }
  }
  
  return { minHour: min, maxHour: max };
}

/**
 * Computes overlap columns for events in a single day.
 * Implements a greedy column-assignment algorithm so events side-by-side share width.
 */
export interface PositionedEvent<T> {
  item: T;
  topMinutes: number;
  durationMinutes: number;
  col: number;
  maxCols: number;
}

export function computeOverlaps<T extends { startsAt: Date | string, endsAt: Date | string }>(
  items: T[], 
  timezone: string
): PositionedEvent<T>[] {
  if (items.length === 0) return [];
  
  // 1. Sort by start time, then duration descending
  const sorted = [...items].sort((a, b) => {
    const aStart = new Date(a.startsAt).getTime();
    const bStart = new Date(b.startsAt).getTime();
    if (aStart !== bStart) return aStart - bStart;
    
    const aDuration = new Date(a.endsAt).getTime() - aStart;
    const bDuration = new Date(b.endsAt).getTime() - bStart;
    return bDuration - aDuration; // Longest first
  });
  
  const positioned: PositionedEvent<T>[] = [];
  let columns: PositionedEvent<T>[][] = [];
  let lastEventEnd = 0;
  
  // 2. Assign columns
  for (const item of sorted) {
    const startParts = getLocalTimeParts(item.startsAt, timezone);
    const endParts = getLocalTimeParts(item.endsAt, timezone);
    
    const topMinutes = startParts.hour * 60 + startParts.minute;
    const endMinutes = endParts.hour * 60 + endParts.minute;
    const durationMinutes = Math.max(endMinutes - topMinutes, 15); // Minimum 15 min height
    
    // If this event starts after ALL current clustered events have ended, 
    // it's a new non-overlapping cluster. Reset columns to maximize width.
    if (columns.length > 0 && topMinutes >= lastEventEnd) {
      for (const col of columns) {
        for (const ev of col) {
          ev.maxCols = columns.length;
        }
      }
      columns = [];
      lastEventEnd = 0;
    }
    
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      if (!col || col.length === 0) continue;
      
      const lastInCol = col[col.length - 1] as PositionedEvent<T>;
      const lastEnd = lastInCol.topMinutes + lastInCol.durationMinutes;
      
      // We can place it in this column if it starts after the last event in this column ends
      if (topMinutes >= lastEnd) {
        const ev = { item, topMinutes, durationMinutes, col: c, maxCols: 1 };
        col.push(ev);
        positioned.push(ev);
        placed = true;
        break;
      }
    }
    
    if (!placed) {
      const ev = { item, topMinutes, durationMinutes, col: columns.length, maxCols: 1 };
      columns.push([ev]);
      positioned.push(ev);
    }
    
    lastEventEnd = Math.max(lastEventEnd, topMinutes + durationMinutes);
  }
  
  // 3. Update maxCols for the final cluster
  for (const col of columns) {
    for (const ev of col) {
      ev.maxCols = columns.length;
    }
  }
  
  return positioned;
}
