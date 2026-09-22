import type { CheckoutRedirect } from '@scalivo/shared';

/**
 * A payment gateway, as the deposit flow needs it.
 *
 * Same reasoning as MessagingProvider: nothing outside this folder knows which
 * gateway it is talking to. The FYP runs JazzCash's sandbox (SPEC §12.2) and
 * Phase 3 adds Stripe; neither change should touch a booking.
 */

export interface CheckoutRequest {
  /** Ours, unique per attempt. The gateway echoes it back on the return. */
  txnRef: string;
  amountMinor: number;
  description: string;
  /** Shown on the customer's statement / wallet history. */
  billReference: string;
  expiresAt: Date;
  /** Where the gateway POSTs the result. */
  returnUrl: string;
}

export type PaymentOutcome = 'paid' | 'failed' | 'pending';

export interface PaymentReturn {
  txnRef: string;
  outcome: PaymentOutcome;
  /** The gateway's own transaction id, for reconciliation with its portal. */
  providerRef: string | null;
  /** What the gateway says it charged, when it says. Checked against what we asked for. */
  amountMinor: number | null;
  code: string | null;
  message: string | null;
}

export interface RefundResult {
  /**
   * `manual` is a real answer, not a failure: the refund is recorded and owed,
   * but has to be issued from the gateway's merchant portal by a person.
   */
  status: 'succeeded' | 'manual' | 'failed';
  providerRef?: string | undefined;
}

export interface PaymentProvider {
  readonly name: 'jazzcash' | 'simulated';

  checkout(request: CheckoutRequest): CheckoutRedirect;

  /**
   * Read a gateway's return, or null if it is not authentic.
   *
   * The return arrives through the CUSTOMER'S BROWSER, so everything in it is
   * something the customer could have edited. A return whose signature does
   * not verify is a forged "I paid" and must be ignored, not merely logged.
   */
  parseReturn(body: Record<string, string>): PaymentReturn | null;

  /**
   * Ask the gateway directly what became of a transaction. Used before
   * releasing a slot whose payment never reported back (SPEC §12.4). `unknown`
   * means "could not tell" — the caller must not treat it as unpaid.
   */
  inquire(txnRef: string): Promise<PaymentOutcome | 'unknown'>;

  refund(request: { txnRef: string; amountMinor: number }): Promise<RefundResult>;
}
