import { postgres } from '../config/db.js';

/**
 * The money ledger, in PostgreSQL — SPEC §12: "payment records + refund/audit
 * trail stored in PostgreSQL (ACID)".
 *
 * Why here and not next to the booking in Mongo: a booking is edited, moved and
 * cancelled; a payment is a fact about money that must never be rewritten, and
 * a refund must happen at most once however many times something asks for it.
 * Both are constraints Postgres enforces for us — a UNIQUE on the transaction
 * reference, a UNIQUE on the refunded payment, CHECKs on status and amount —
 * rather than rules every caller has to remember.
 *
 * The same principle as the booking grid: the database is the arbiter. Every
 * status change below is a conditional UPDATE whose WHERE clause is the guard,
 * so a replayed gateway callback or a double-clicked button changes nothing
 * the second time.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  id            BIGSERIAL PRIMARY KEY,
  txn_ref       TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  booking_id    TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL DEFAULT 'PKR',
  status        TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments (booking_id);
CREATE INDEX IF NOT EXISTS payments_business_idx ON payments (business_id, created_at);

-- One refund per payment, always the full amount. The UNIQUE is the
-- exactly-once guarantee: a second attempt conflicts instead of paying twice.
CREATE TABLE IF NOT EXISTS refunds (
  id            BIGSERIAL PRIMARY KEY,
  payment_id    BIGINT NOT NULL UNIQUE REFERENCES payments (id),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'manual', 'failed')),
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);

-- Append-only. Every gateway return (including forged ones), every expiry,
-- every transfer. What "reconcile" reads when the numbers disagree.
CREATE TABLE IF NOT EXISTS payment_events (
  id          BIGSERIAL PRIMARY KEY,
  txn_ref     TEXT,
  booking_id  TEXT,
  kind        TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_booking_idx ON payment_events (booking_id);
`;

/** Idempotent; run at boot. Additive changes only — a real migration tool comes with the first ALTER. */
export async function ensurePaymentSchema(): Promise<void> {
  await postgres.query(SCHEMA);
}

export interface PaymentRow {
  id: string;
  txn_ref: string;
  provider: string;
  business_id: string;
  booking_id: string;
  client_id: string;
  amount_minor: string;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  provider_ref: string | null;
}

export async function insertPayment(row: {
  txnRef: string;
  provider: string;
  businessId: string;
  bookingId: string;
  clientId: string;
  amountMinor: number;
}): Promise<void> {
  await postgres.query(
    `INSERT INTO payments (txn_ref, provider, business_id, booking_id, client_id, amount_minor, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [row.txnRef, row.provider, row.businessId, row.bookingId, row.clientId, row.amountMinor],
  );
}

/**
 * pending → paid, once. An `expired` payment can still become paid: the money
 * arrived late, it is real, and it has to be recorded so it can be refunded.
 * Returns null when nothing changed — a replay, or an unknown reference.
 */
export async function markPaid(txnRef: string, providerRef: string | null): Promise<PaymentRow | null> {
  const { rows } = await postgres.query<PaymentRow>(
    `UPDATE payments SET status = 'paid', provider_ref = $2, settled_at = now()
     WHERE txn_ref = $1 AND status IN ('pending', 'expired')
     RETURNING *`,
    [txnRef, providerRef],
  );
  return rows[0] ?? null;
}

export async function markFailed(txnRef: string): Promise<void> {
  await postgres.query(
    `UPDATE payments SET status = 'failed', settled_at = now() WHERE txn_ref = $1 AND status = 'pending'`,
    [txnRef],
  );
}

export async function expirePending(bookingId: string): Promise<void> {
  await postgres.query(
    `UPDATE payments SET status = 'expired', settled_at = now() WHERE booking_id = $1 AND status = 'pending'`,
    [bookingId],
  );
}

export async function pendingPayments(bookingId: string): Promise<PaymentRow[]> {
  const { rows } = await postgres.query<PaymentRow>(
    `SELECT * FROM payments WHERE booking_id = $1 AND status = 'pending'`,
    [bookingId],
  );
  return rows;
}

/** Paid and not yet refunded — what a refund for this booking would send back. */
export async function refundablePayments(bookingId: string): Promise<PaymentRow[]> {
  const { rows } = await postgres.query<PaymentRow>(
    `SELECT p.* FROM payments p
     LEFT JOIN refunds r ON r.payment_id = p.id
     WHERE p.booking_id = $1 AND p.status = 'paid' AND r.id IS NULL`,
    [bookingId],
  );
  return rows;
}

/**
 * Claim the refund. Returns false when one already exists — the caller must
 * then NOT ask the gateway for the money, because someone else already has.
 */
export async function claimRefund(payment: PaymentRow, reason: string): Promise<boolean> {
  const { rowCount } = await postgres.query(
    `INSERT INTO refunds (payment_id, amount_minor, reason, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (payment_id) DO NOTHING`,
    [payment.id, payment.amount_minor, reason],
  );
  return rowCount === 1;
}

export async function settleRefund(
  paymentId: string,
  status: 'succeeded' | 'manual' | 'failed',
  providerRef: string | null,
): Promise<void> {
  await postgres.query(
    `UPDATE refunds SET status = $2, provider_ref = $3, settled_at = now() WHERE payment_id = $1`,
    [paymentId, status, providerRef],
  );
}

/** A rescheduled booking takes its paid deposit with it. */
export async function moveToBooking(fromBookingId: string, toBookingId: string): Promise<void> {
  await postgres.query(`UPDATE payments SET booking_id = $2 WHERE booking_id = $1 AND status = 'paid'`, [
    fromBookingId,
    toBookingId,
  ]);
}

export async function recordEvent(event: {
  kind: string;
  txnRef?: string | null;
  bookingId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await postgres.query(
    `INSERT INTO payment_events (kind, txn_ref, booking_id, detail) VALUES ($1, $2, $3, $4)`,
    [event.kind, event.txnRef ?? null, event.bookingId ?? null, JSON.stringify(event.detail ?? {})],
  );
}
