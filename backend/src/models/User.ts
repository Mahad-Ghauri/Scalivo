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
  },
  { timestamps: true },
);

export const User = model('User', userSchema);
