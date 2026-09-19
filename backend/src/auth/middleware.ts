import type { NextFunction, Request, Response } from 'express';
import { type AuthToken, verifyToken } from './jwt.js';

/**
 * Multi-tenancy is enforced here or not at all.
 *
 * Every tenant-owned document carries a businessId, and a missing scope check
 * is a data leak — one salon reading another's client list. So the rule is:
 * a route that names a businessId must call assertTenantAccess before it
 * touches the database, not after.
 */

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  try {
    res.locals.auth = verifyToken(header.slice('Bearer '.length));
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

export function getAuth(res: Response): AuthToken {
  const auth = res.locals.auth as AuthToken | undefined;
  if (!auth) throw new Error('getAuth called on an unauthenticated route');
  return auth;
}

export class TenantAccessError extends Error {
  constructor() {
    super('token is not scoped to this business');
    this.name = 'TenantAccessError';
  }
}

/**
 * Admins are cross-tenant by design — the one role that bypasses scoping, and
 * the reason admin actions belong in an audit trail. Everyone else may only
 * reach a business their token names.
 */
export function assertTenantAccess(auth: AuthToken, businessId: string): void {
  if (auth.role === 'admin') return;
  if (!auth.businessIds.includes(businessId)) throw new TenantAccessError();
}

/** Route-level guard: 404s before the handler runs, so no query is ever issued. */
export function requireTenant(param = 'businessId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const value = req.params[param];
      assertTenantAccess(getAuth(res), typeof value === 'string' ? value : '');
      next();
    } catch {
      // Return 404 rather than 403 to prevent resource enumeration.
      // (Previously returned 403, which the Next.js frontend masked as 404).
      res.status(404).json({ error: 'not found' });
    }
  };
}
