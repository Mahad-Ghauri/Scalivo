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

/**
 * Pinned, on both sides (4.2).
 *
 * `verify` without this accepts any algorithm the key type can support, so the
 * token itself gets a say in how it is checked — and an attacker who can choose
 * the algorithm has removed a decision that should only ever be ours. Current
 * jsonwebtoken already refuses `alg: none`, which is the famous version of this
 * bug; pinning is what stops the next one being our problem.
 *
 * Note what this does NOT fix: `businessIds` is a claim, so a token stays valid
 * for its full seven days even after an owner is removed from a business. There
 * is no revocation list. docs/data-handling.md records it as an accepted risk
 * and what it would cost to close.
 */
const ALGORITHM = 'HS256' as const;

export function signToken(payload: AuthToken): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TTL, algorithm: ALGORITHM });
}

/** Throws on a tampered, expired, or wrong-secret token. */
export function verifyToken(token: string): AuthToken {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGORITHM],
  }) as jwt.JwtPayload & Partial<AuthToken>;

  if (!decoded.userId || !decoded.role) throw new Error('token missing required claims');

  return {
    userId: decoded.userId,
    role: decoded.role,
    businessIds: decoded.businessIds ?? [],
  };
}
