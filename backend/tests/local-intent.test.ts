import { describe, expect, it } from 'vitest';
import { localIntent, resolveIntent, type Vocabulary } from '../src/whatsapp/fsm/intent.js';

// Pure: no model, no database. Proves the menus can be answered without Gemini.
const vocabulary: Vocabulary = {
  services: [
    { id: 's1', name: 'Consultation' },
    { id: 's2', name: 'Hydrafacial' },
    { id: 's3', name: 'Laser session' },
    { id: 's4', name: 'Chemical peel' },
  ],
  staff: [
    { id: 'a', name: 'Dr Ayesha Malik', serviceIds: ['s1', 's2'] },
    { id: 'b', name: 'Sana', serviceIds: ['s1', 's3'] },
  ],
};
// Friday 28 Nov 2026, 15:00 Karachi.
const now = new Date('2026-11-28T10:00:00Z');
const tz = 'Asia/Karachi';
const read = (text: string) => localIntent(text, vocabulary, now, tz);
const resolve = (text: string) =>
  resolveIntent(read(text)!, { ...vocabulary, timezone: tz, now });

describe('localIntent', () => {
  it('reads a service by its full name in a sentence', () => {
    expect(read('i would like consultation')).toMatchObject({ action: 'booking', service: 'Consultation' });
    expect(resolve('Consultation').serviceId).toBe('s1');
  });

  it('reads a service by one significant word', () => {
    expect(resolve('laser please').serviceId).toBe('s3');
    expect(resolve('a peel').serviceId).toBe('s4');
  });

  it('treats a question about services as a services question, not a mistake', () => {
    expect(read('i would like to know about services')?.action).toBe('services');
  });

  it('reads prices, location and hours questions', () => {
    expect(read('how much is a hydrafacial')).toMatchObject({ action: 'price', service: 'Hydrafacial' });
    expect(read('where are you located')?.action).toBe('location');
    expect(read('what are your timings')?.action).toBe('hours');
  });

  it('reads staff by first name and "anyone"', () => {
    expect(read('sana')?.staff).toBe('Sana');
    expect(read('ayesha')?.staff).toBe('Dr Ayesha Malik');
    expect(read('anyone is fine')?.action).toBe('no_preference');
    expect(read('No preference')?.action).toBe('no_preference');
  });

  it('reads relative days, weekdays and written dates', () => {
    expect(resolve('consultation tomorrow').date).toBe('2026-11-29');
    expect(resolve('consultation on monday').date).toBe('2026-11-30');
    expect(resolve('consultation 3 december').date).toBe('2026-12-03');
    expect(resolve('consultation dec 3rd').date).toBe('2026-12-03');
  });

  it('reads a time-of-day window', () => {
    expect(resolve('hydrafacial saturday evening').within?.label).toBe('in the evening');
  });

  it('returns nothing for text with nothing in it', () => {
    expect(read('ok thanks')).toBeNull();
    expect(read('12')).toBeNull();
  });
});
