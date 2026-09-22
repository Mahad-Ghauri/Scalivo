import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CheckoutRedirect } from '@scalivo/shared';
import type {
  CheckoutRequest,
  PaymentOutcome,
  PaymentProvider,
  PaymentReturn,
  RefundResult,
} from './provider.js';

/**
 * A stand-in gateway, served by this backend: a checkout page with "Pay" and
 * "Decline" buttons that returns a signed result exactly the way JazzCash does.
 *
 * It exists so the whole deposit loop — hold, pay, confirm, expire, refund —
 * runs on a laptop and in tests without merchant credentials. It is refused in
 * production by the env schema: it confirms bookings nobody paid for.
 *
 * The signature is real even here. The return comes back through the browser,
 * and the code that verifies it is the code that must reject a forged one.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated' as const;

  /** What the "gateway" knows happened, for inquire(). Tests reach in to set it. */
  readonly settled = new Map<string, PaymentOutcome>();
  readonly refunds: { txnRef: string; amountMinor: number }[] = [];

  constructor(
    private readonly secret: string,
    /** This backend's public URL; the checkout page is served from it. */
    private readonly baseUrl: string,
  ) {}

  sign(txnRef: string, outcome: string): string {
    return createHmac('sha256', this.secret).update(`sim:${txnRef}:${outcome}`).digest('hex');
  }

  checkout(request: CheckoutRequest): CheckoutRedirect {
    return {
      url: `${this.baseUrl}/payments/simulated/checkout`,
      method: 'GET',
      fields: {
        txnRef: request.txnRef,
        amountMinor: String(request.amountMinor),
        description: request.description,
      },
    };
  }

  /** The signed body the checkout page's buttons submit. */
  returnBody(txnRef: string, outcome: PaymentOutcome): Record<string, string> {
    return { txnRef, outcome, signature: this.sign(txnRef, outcome) };
  }

  parseReturn(body: Record<string, string>): PaymentReturn | null {
    const { txnRef = '', outcome = '', signature = '' } = body;
    if (!['paid', 'failed', 'pending'].includes(outcome)) return null;

    const a = Buffer.from(signature);
    const b = Buffer.from(this.sign(txnRef, outcome));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    this.settled.set(txnRef, outcome as PaymentOutcome);
    return {
      txnRef,
      outcome: outcome as PaymentOutcome,
      providerRef: outcome === 'paid' ? `SIM-${txnRef}` : null,
      amountMinor: null,
      code: outcome === 'paid' ? '000' : '999',
      message: outcome === 'paid' ? 'Simulated payment' : 'Simulated decline',
    };
  }

  async inquire(txnRef: string): Promise<PaymentOutcome | 'unknown'> {
    return this.settled.get(txnRef) ?? 'pending';
  }

  async refund(request: { txnRef: string; amountMinor: number }): Promise<RefundResult> {
    this.refunds.push(request);
    return { status: 'succeeded', providerRef: `SIMREFUND-${request.txnRef}` };
  }
}
