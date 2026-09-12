import { Schema, model } from 'mongoose';
import {
  DEFAULT_BOOKING_HORIZON_DAYS,
  DEFAULT_MIN_NOTICE_MINUTES,
  DEFAULT_SLOT_INCREMENT_MINUTES,
  SESSION_INTENT,
  SESSION_STATUS,
} from '@scalivo/shared';

const businessSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true },

    /** Free text for now. The marketplace will need this normalised; signup won't. */
    city: { type: String, default: null },

    /** IANA zone. Every displayed time converts through this, never the server's. */
    timezone: { type: String, default: 'Asia/Karachi' },
    slotIncrementMinutes: { type: Number, default: DEFAULT_SLOT_INCREMENT_MINUTES },

    /**
     * Booking window. Without a floor the 09:00 slot is still offerable at
     * 08:58; without a ceiling "next free slot" scans forever on a full diary.
     */
    minNoticeMinutes: { type: Number, default: DEFAULT_MIN_NOTICE_MINUTES },
    bookingHorizonDays: { type: Number, default: DEFAULT_BOOKING_HORIZON_DAYS },

    whatsapp: {
      sessionId: { type: String, index: true },
      status: { type: String, enum: Object.values(SESSION_STATUS), default: SESSION_STATUS.CREATED },

      /**
       * What we believe should be happening. Without it, Session Health cannot
       * tell a qr_ready we caused by linking a business from one meaning the
       * session just died — they are the same event.
       */
      intent: {
        type: String,
        enum: Object.values(SESSION_INTENT),
        default: SESSION_INTENT.STOPPED,
      },

      lastStatusChange: { type: Date, default: Date.now },

      /** When the owner was last told. Backs the alert cooldown across restarts. */
      lastAlertAt: { type: Date, default: null },
      lastInboundAt: { type: Date, default: null },
      reconnectAttempts: { type: Number, default: 0 },

      /** One scoped OpenWA key per business, never the shared admin key. */
      apiKeyRef: { type: String, default: null },
    },

    /** Hidden from the marketplace until the minimum profile fields are set. */
    published: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Business = model('Business', businessSchema);
