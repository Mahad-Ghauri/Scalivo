import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import type { CheckoutRedirect } from '@scalivo/shared';
import type {
  CheckoutRequest,
  PaymentOutcome,
  PaymentProvider,
  PaymentReturn,
  RefundResult,
} from './provider.js';
import { logger } from '../lib/logger.js';

/**
 * JazzCash hosted checkout ("Page Redirection", API v1.1), sandbox.
 *
 * WRITTEN FROM JAZZCASH'S PUBLISHED INTEGRATION GUIDE AND NOT YET RUN AGAINST
 * THE SANDBOX — merchant credentials are needed for that, and SPEC §12.2 notes
 * the registration gate. The simulated provider covers every behaviour this
 * one has to have; this file is the part to verify on first contact, starting
 * with the hash and the response codes below.
 *
 * The flow: our page POSTs signed `pp_` fields to JazzCash's form endpoint,
 * the customer pays in their wallet or by card, and JazzCash POSTs the result
 * back through the customer's browser to `pp_ReturnURL`, signed the same way.
 */

/** JazzCash transaction timestamps are Pakistan wall-clock, yyyyMMddHHmmss. */
const stamp = (at: Date) =>
  DateTime.fromJSDate(at).setZone('Asia/Karachi').toFormat('yyyyMMddHHmmss');

/** "000" is success; these two mean the money is committed but not yet settled. */
const PENDING_CODES = new Set(['124', '157']);

export class JazzCashProvider implements PaymentProvider {
  readonly name = 'jazzcash' as const;

  constructor(
    private readonly config: {
      merchantId: string;
      password: string;
      integritySalt: string;
      baseUrl: string;
    },
  ) {}

  /**
   * pp_SecureHash: HMAC-SHA256, keyed with the integrity salt, over the salt
   * followed by every non-empty pp_/ppmpf_ value in ALPHABETICAL ORDER OF KEY,
   * joined with '&'. Upper-case hex.
   */
  private sign(fields: Record<string, string>): string {
    const values = Object.keys(fields)
      .filter((key) => /^pp(mpf)?_/i.test(key) && key !== 'pp_SecureHash')
      .sort()
      .map((key) => fields[key] ?? '')
      .filter((value) => value !== '');

    return createHmac('sha256', this.config.integritySalt)
      .update([this.config.integritySalt, ...values].join('&'))
      .digest('hex')
      .toUpperCase();
  }

  checkout(request: CheckoutRequest): CheckoutRedirect {
    const fields: Record<string, string> = {
      pp_Version: '1.1',
      // Empty lets the customer choose wallet, card or voucher on JazzCash's page.
      pp_TxnType: '',
      pp_Language: 'EN',
      pp_MerchantID: this.config.merchantId,
      pp_SubMerchantID: '',
      pp_Password: this.config.password,
      pp_TxnRefNo: request.txnRef,
      // Paisa, as a plain integer string — the same unit we store.
      pp_Amount: String(request.amountMinor),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: stamp(new Date()),
      pp_BillReference: request.billReference,
      pp_Description: request.description.slice(0, 100),
      pp_TxnExpiryDateTime: stamp(request.expiresAt),
      pp_ReturnURL: request.returnUrl,
    };
    fields.pp_SecureHash = this.sign(fields);

    return {
      url: `${this.config.baseUrl}/CustomerPortal/transactionmanagement/merchantform/`,
      method: 'POST',
      fields,
    };
  }

  parseReturn(body: Record<string, string>): PaymentReturn | null {
    const received = body.pp_SecureHash ?? '';
    const expected = this.sign(body);
    const a = Buffer.from(received.toUpperCase());
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // A correctly signed return for another merchant is still not ours.
    if (body.pp_MerchantID && body.pp_MerchantID !== this.config.merchantId) return null;

    const code = body.pp_ResponseCode ?? null;
    const outcome: PaymentOutcome =
      code === '000' ? 'paid' : code && PENDING_CODES.has(code) ? 'pending' : 'failed';

    return {
      txnRef: body.pp_TxnRefNo ?? '',
      outcome,
      providerRef: body.pp_RetreivalReferenceNo ?? body.pp_AuthCode ?? null,
      amountMinor: body.pp_Amount ? Number(body.pp_Amount) : null,
      code,
      message: body.pp_ResponseMessage ?? null,
    };
  }

  /**
   * Status Inquiry API. Conservative by design: anything but an unambiguous
   * answer is `unknown`, and the expiry pass holds the slot through its grace
   * period rather than cancelling a booking whose money may be in flight.
   */
  async inquire(txnRef: string): Promise<PaymentOutcome | 'unknown'> {
    const fields: Record<string, string> = {
      pp_TxnRefNo: txnRef,
      pp_MerchantID: this.config.merchantId,
      pp_Password: this.config.password,
      pp_Version: '1.1',
    };
    fields.pp_SecureHash = this.sign(fields);

    try {
      const res = await fetch(`${this.config.baseUrl}/ApplicationAPI/API/PaymentInquiry/Inquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as Record<string, string>;
      if (data.pp_ResponseCode !== '000') return 'unknown';
      // 121: "transaction completed"; 157: pending; anything else, not paid.
      if (data.pp_PaymentResponseCode === '121') return 'paid';
      if (data.pp_PaymentResponseCode === '157') return 'pending';
      return data.pp_PaymentResponseCode ? 'failed' : 'unknown';
    } catch (err) {
      logger.warn({ err, txnRef }, 'jazzcash inquiry failed');
      return 'unknown';
    }
  }

  /**
   * Recorded as MANUAL. JazzCash's refund APIs are enabled per merchant and per
   * payment method, and none is available on a fresh sandbox account — so the
   * refund is written to the ledger as owed and issued from the merchant
   * portal. The ledger, not the gateway, is the audit trail SPEC §12 asks for.
   */
  async refund(): Promise<RefundResult> {
    return { status: 'manual' };
  }
}
