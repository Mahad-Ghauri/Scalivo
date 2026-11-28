/**
 * Phone numbers reserved for seed and demo data.
 *
 * A Pakistani national number never starts with 0 after the country code, so
 * `920…` cannot belong to anyone. Seeded clients get numbers in this range, and
 * nothing is ever sent to them, so test data can never message a real person.
 */
export const TEST_PHONE_PREFIX = '920';

export function seedPhone(n: number): string {
  return `${TEST_PHONE_PREFIX}000${String(n).padStart(6, '0')}`;
}

export function isTestNumber(to: string): boolean {
  return to.replace(/\D/g, '').startsWith(TEST_PHONE_PREFIX) && !to.includes('@lid');
}
