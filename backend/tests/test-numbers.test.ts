import { describe, expect, it } from 'vitest';
import { isTestNumber, seedPhone } from '../src/messaging/test-numbers.js';

// Seed data once messaged a real person (03001234021). These keep it from happening again.
describe('reserved test numbers', () => {
  it('seeds numbers no real person can have', () => {
    expect(seedPhone(1000)).toBe('920000001000');
    expect(isTestNumber(seedPhone(1021))).toBe(true);
  });

  it('never flags real Pakistani numbers or LIDs', () => {
    expect(isTestNumber('923001234021')).toBe(false);
    expect(isTestNumber('923209263011')).toBe(false);
    expect(isTestNumber('920000001000@lid')).toBe(false);
  });
});
