import { Schema, model } from 'mongoose';

/**
 * A person, global across businesses.
 *
 * `phone` is nullable and its unique index is PARTIAL — deliberately. Two things
 * produce a client with no phone number: a LID whose resolution failed
 * (FINDING #1), and an owner-created walk-in. A plain unique index would let
 * only one of them exist.
 *
 * It has to be partial rather than sparse. `default: null` means the key is
 * always *present*, just null — and a sparse index only skips documents where
 * the field is absent, so it would happily index every null and collide on the
 * second phone-less client. The partial filter keys on the value instead.
 */
const clientSchema = new Schema(
  {
    /** E.164 without '+'. */
    phone: { type: String, default: null },

    /**
     * Every WhatsApp linked-identity seen for this person. This is what an
     * inbound message is actually matched on, since `from` is a LID and never a
     * phone number. Populated even when the phone is unknown, so an unresolved
     * contact still has a stable key and can be merged later.
     */
    lids: { type: [String], default: [], index: true },

    displayName: { type: String, default: null },

    /**
     * Set by a bare `STOP`. Suppresses MARKETING only — retention nudges,
     * win-back, broadcasts.
     *
     * Confirmations and reminders keep flowing, because they are transactional:
     * the customer asked for the appointment, and silently dropping its
     * reminder would be a worse failure than the opt-out was a request. The
     * distinction is the whole reason this is a flag and not a delete.
     */
    marketingOptOut: { type: Boolean, default: false },
  },
  { timestamps: true },
);

clientSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);

export const Client = model('Client', clientSchema);
