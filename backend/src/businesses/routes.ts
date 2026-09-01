import express, { type Router } from 'express';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';

export function createBusinessRouter(): Router {
  const router = express.Router();

  // requireTenant runs before the handler, so a cross-tenant request is refused
  // without a single query being issued. That ordering is the isolation
  // guarantee — a check after the read has already loaded the other tenant's row.
  router.get('/:businessId', requireAuth, requireTenant(), async (req, res) => {
    const business = await Business.findById(req.params.businessId);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(business);
  });

  return router;
}
