import bcrypt from 'bcryptjs';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { UserRole } from '@scalivo/shared';
import { User } from '../models/User.js';
import { signToken } from './jwt.js';
import { logger } from '../lib/logger.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

export function createAuthRouter(): Router {
  const router = express.Router();

  router.post('/login', express.json(), async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }

    const user = await User.findOne({ email: parsed.data.email.toLowerCase() });

    // Same response whether the email is unknown or the password is wrong —
    // otherwise this endpoint enumerates which owners have accounts.
    const ok = user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
    if (!user || !ok) {
      logger.warn({ email: parsed.data.email }, 'failed login');
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    res.json({
      token: signToken({
        userId: String(user._id),
        role: user.role as UserRole,
        businessIds: user.businessIds,
      }),
      role: user.role,
    });
  });

  return router;
}
