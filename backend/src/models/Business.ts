import { Schema, model } from 'mongoose';
import {
  DEFAULT_BOOKING_HORIZON_DAYS,
  DEFAULT_MIN_NOTICE_MINUTES,
  DEFAULT_REMINDER_LEAD_MINUTES,
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

      /**
       * The linked number, E.164 without '+', cached from the gateway.
       *
       * For building the wa.me link an owner puts on a poster — NOT a liveness
       * signal. FINDING #2: a dead session still reports its original phone.
       */
      phone: { type: String, default: null },
    },

    reminders: {
      /**
       * Off is a real choice, not a broken install. A business whose customers
       * all walk in has nothing to remind anyone about, and a reminder they did
       * not ask for reads as spam on the one channel they cannot afford to be
       * reported on.
       */
      enabled: { type: Boolean, default: true },

      /**
       * Minutes before the appointment, one entry per reminder.
       *
       * An array rather than a single number because the two businesses this is
       * being built for want different things and both are ordinary: a salon
       * reminds the day before, a gym class two hours ahead. Each entry gets its
       * own dedupe claim, so adding one later starts reminding without
       * re-reminding anybody about what has already gone out.
       */
      leadMinutes: {
        type: [Number],
        default: () => [...DEFAULT_REMINDER_LEAD_MINUTES],
      },
    },

    /** Hidden from the marketplace until the minimum profile fields are set. */
    published: { type: Boolean, default: false },

    /**
     * What the public profile page shows. Presentation only — nothing here is
     * read by booking, availability or messaging, and all of it is optional so
     * an unpublished business need not fill any of it in.
     */
    profile: {
      tagline: { type: String, default: '' },
      about: { type: String, default: '' },
      neighbourhood: { type: String, default: null },
      addressLine: { type: String, default: null },
      logoUrl: { type: String, default: null },
      coverUrl: { type: String, default: null },
      /** 2.1's bounded customisation: one accent colour, as '#rrggbb'. */
      themeColor: { type: String, default: null },
      gallery: {
        type: [{ url: { type: String, required: true }, alt: { type: String, required: true }, _id: false }],
        default: [],
      },
    },
  },
  { timestamps: true },
);

export const Business = model('Business', businessSchema);
