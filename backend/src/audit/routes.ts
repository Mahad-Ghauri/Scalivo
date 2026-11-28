import express, { type Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { isCalendarDate } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { renderAuditPdf } from './pdf.js';
import { AUDIT_CATEGORIES, buildAuditReport } from './report.js';

/**
 *   GET /businesses/:id/audit?from&to[&category][&search]       the report as JSON
 *   GET /businesses/:id/audit/report.pdf?from&to[&category][&search]  the same, as a PDF
 */

const MAX_RANGE_DAYS = 366;

const query = z
  .object({
    from: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD'),
    to: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD'),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    search: z.string().max(100).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'The end date is before the start date', path: ['to'] })
  .refine(
    (q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= MAX_RANGE_DAYS,
    { message: 'Choose a period of a year or less', path: ['from'] },
  );

export function createAuditRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;

  const load = async (req: express.Request, res: express.Response) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid report range', fields: fieldErrors(parsed.error) });
      return null;
    }
    const report = await buildAuditReport(param(req, 'businessId'), parsed.data);
    if (!report) res.status(404).json({ error: 'business not found' });
    return report;
  };

  router.get('/:businessId/audit', ...guard, async (req, res) => {
    const report = await load(req, res);
    if (report) res.json(report);
  });

  router.get('/:businessId/audit/report.pdf', ...guard, async (req, res) => {
    const report = await load(req, res);
    if (!report) return;
    try {
      const pdf = await renderAuditPdf(report);
      const name = `audit-report-${report.range.from}-to-${report.range.to}.pdf`;
      res
        .status(200)
        .set({
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${name}"`,
          'cache-control': 'no-store',
        })
        .send(pdf);
    } catch (err) {
      logger.error({ err }, 'could not render audit pdf');
      res.status(500).json({ error: 'Could not create the PDF.' });
    }
  });

  return router;
}
