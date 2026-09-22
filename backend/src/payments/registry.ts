import { env } from '../config/env.js';
import { JazzCashProvider } from './jazzcash.js';
import type { PaymentProvider } from './provider.js';
import { SimulatedProvider } from './simulated.js';

/**
 * The one payment provider this process uses.
 *
 * A module-level slot rather than a parameter threaded everywhere, because a
 * refund can be triggered from deep inside setBookingOutcome — an owner
 * cancelling from the calendar, a customer typing CANCEL — and none of those
 * call sites should have to know that money exists. Set once at boot, and by
 * tests.
 */
let current: PaymentProvider | null = null;

export function usePaymentProvider(provider: PaymentProvider): void {
  current = provider;
}

export function paymentProvider(): PaymentProvider {
  if (!current) throw new Error('payment provider not configured — call usePaymentProvider at boot');
  return current;
}

export function createPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'jazzcash') {
    // env.ts has already refused to boot without all three.
    return new JazzCashProvider({
      merchantId: env.JAZZCASH_MERCHANT_ID!,
      password: env.JAZZCASH_PASSWORD!,
      integritySalt: env.JAZZCASH_INTEGRITY_SALT!,
      baseUrl: env.JAZZCASH_BASE_URL,
    });
  }
  return new SimulatedProvider(env.JWT_SECRET, env.PUBLIC_URL);
  
}
