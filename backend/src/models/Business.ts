import { Schema, model } from 'mongoose';
import { SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';

const businessSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true },

    /** Free text for now. The marketplace will need this normalised; signup won't. */
    city: { type: String, default: null },

    /** IANA zone. Every displayed time converts through this, never the server's. */
    timezone: { type: String, default: 'Asia/Karachi' },
    slotIncrementMinutes: { type: Number, default: 15 },

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
