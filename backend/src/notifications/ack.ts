import {
  DELIVERY_STATUS,
  deliveryFromAck,
  deliveryStatusesFrom,
  type MessageAck,
} from '@scalivo/shared';
import { Notification } from '../models/Notification.js';
import { logger } from '../lib/logger.js';

/**
 * The only evidence that a message arrived.
 *
 * Everything else in the send path is hope. `sendText` returns `{messageId,
 * timestamp}` whether or not WhatsApp ever delivers anything, and under upstream
 * #830 it silently drops first contact to a brand-new contact while still
 * answering 200 — which describes most of the customers of a business that just
 * moved to a new dedicated number. So an acknowledged send is not a sent
 * message; this webhook is.
 *
 * **Acks are not ordered.** They arrive as separate deliveries over an
 * at-least-once transport with its own retries, so 'sent' can land after
 * 'delivered'. The write is therefore conditional on not going backwards — see
 * advancesDelivery in the shared contract. Without that guard a retried 'sent'
 * would downgrade a message we know arrived, and the delivery-rate metric that
 * the thesis reports would drift downward over time for no reason at all.
 *
 * **Most acks match nothing, and that is correct.** Every conversational reply
 * the FSM sends produces acks too, and none of them is tracked — a menu prompt
 * nobody receives is re-requested by a customer who messages again. Only
 * confirmations and reminders have a row to update, so an unmatched ack is
 * logged at debug and dropped rather than treated as an anomaly.
 */
export async function handleMessageAck(ack: MessageAck): Promise<void> {
  const next = deliveryFromAck(ack.status);

  // 'pending' and 'sent' carry no information ACCEPTED does not already hold.
  if (!next) return;

  const result = await Notification.findOneAndUpdate(
    {
      providerMessageId: ack.providerMessageId,
      // The rank guard, expressed as a filter so the check and the write are one
      // operation. Two acks arriving at once cannot both pass.
      status: { $nin: deliveryStatusesFrom(next) },
    },
    /**
     * A pipeline update, for one reason: `deliveredAt` must be stamped once and
     * never restamped.
     *
     * READ implies arrival just as DELIVERED does, and WhatsApp can skip
     * straight to it when someone has the chat open — so both set the field, or
     * a message the customer read would show as never delivered. But a plain
     * `$set` on the second of the two would overwrite the earlier, truer
     * instant, and $ifNull is what makes "first one wins" a property of the
     * write rather than of the order the acks happen to arrive in.
     */
    [
      {
        $set: {
          status: next,
          ...(next === DELIVERY_STATUS.DELIVERED || next === DELIVERY_STATUS.READ
            ? { deliveredAt: { $ifNull: ['$deliveredAt', ack.occurredAt] } }
            : {}),
        },
      },
    ],
    { new: true },
  );

  if (!result) {
    logger.debug(
      { providerMessageId: ack.providerMessageId, status: ack.status },
      'ack matched no tracked notification',
    );
    return;
  }

  logger.info(
    {
      notificationId: String(result._id),
      businessId: result.businessId,
      bookingId: result.bookingId,
      kind: result.kind,
      status: next,
    },
    'notification delivery confirmed by ack',
  );
}
