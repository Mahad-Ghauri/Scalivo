import jwt from 'jsonwebtoken';
import type { UserRole } from '@scalivo/shared';
import { env } from '../config/env.js';

/**
 * What every authenticated request carries.
 *
 * `businessIds` is on the token rather than looked up per request so tenant
 * scoping costs nothing — which matters, because a scope check that is
 * expensive is a scope check someone will eventually skip.
 */
export interface AuthToken {
  userId: string;
  role: UserRole;
  businessIds: string[];
}

const TTL = '7d';

export function signToken(payload: AuthToken): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TTL });
}

/** Throws on a tampered, expired, or wrong-secret token. */
export function verifyToken(token: string): AuthToken {
  const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & Partial<AuthToken>;

  if (!decoded.userId || !decoded.role) throw new Error('token missing required claims');

  return {
    userId: decoded.userId,
    role: decoded.role,
    businessIds: decoded.businessIds ?? [],
  };
}
