import { Schema, model } from 'mongoose';

/**
 * Owners, staff, and admins — the accounts that log in with a password.
 *
 * Customers are deliberately absent: they are `Client` records keyed on a phone
 * number, with no password and no signup. That asymmetry is what makes "zero
 * manual data entry" possible.
 */
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: null },
    role: { type: String, enum: ['staff', 'owner', 'admin'], required: true },

    /** Which tenants this user may touch. Admins bypass this; nobody else does. */
    businessIds: { type: [String], default: [] },

    /**
     * FCM registration tokens, one per device the owner has logged in on.
     *
     * A list rather than a single value because Session Health is the one alert
     * that must not be missed: an owner with a phone and a tablet should get the
     * "WhatsApp is down" push on both. Tokens rotate silently on the device, so
     * this is append-on-login and prune-on-send-failure, never authoritative.
     */
    fcmTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

userSchema.index(
  { fcmTokens: 1 },
  { unique: true, partialFilterExpression: { 'fcmTokens.0': { $exists: true } } },
);

export const User = model('User', userSchema);
