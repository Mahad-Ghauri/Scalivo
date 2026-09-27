import type { EvaluationReport } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { businessDayBounds } from '../lib/time.js';
import {
  adoptionMetric,
  agentMetric,
  completionMetric,
  noShowMetric,
  retentionMetric,
  reviewMetric,
  type Window,
} from './metrics.js';
import { sessionUptime } from './uptime.js';

/**
 * The whole metric set for one business, over one window — milestone 3.9's DoD.
 *
 * The DoD is "every evaluation metric can be pulled on demand, proven by running the
 * whole set", so the whole set is one function. That is not packaging: a pipeline
 * where each metric is pulled separately is one where nobody notices that the fifth
 * one has been throwing since March, and the point of building this before the pilot
 * is to find exactly that kind of hole while the data is still being generated.
 *
 * The window is given as business-local dates and converted here. Every metric then
 * receives the same instants, so a figure cannot disagree with the one beside it
 * about which days it covered — which is the failure mode of an evaluation assembled
 * from separately-written queries, and the one that is impossible to spot in a table
 * of results.
 */
export async function buildEvaluation(
  businessId: string,
  /** Business-local 'YYYY-MM-DD', both inclusive. */
  from: string,
  to: string,
  now = new Date(),
): Promise<EvaluationReport> {
  const business = await Business.findById(businessId);
  if (!business) throw new Error(`no business ${businessId}`);

  const timezone = business.timezone;

  const window: Window = {
    businessId,
    timezone,
    from: businessDayBounds(from, timezone).start,
    // The END of the last day, so a window of one day covers that whole day rather
    // than collapsing to the instant it began.
    to: businessDayBounds(to, timezone).end,
    fromDay: from,
    toDay: to,
    now,
  };

  // Run together: they touch different collections, share no state, and a pipeline
  // that takes a minute per metric is one nobody runs twice.
  const [noShow, retention, completion, uptime, adoption, reviews, agent] = await Promise.all([
    noShowMetric(window),
    retentionMetric(window),
    completionMetric(window),
    sessionUptime(businessId, window.from, window.to, now),
    adoptionMetric(window),
    reviewMetric(window),
    agentMetric(window),
  ]);

  return {
    businessId,
    businessName: business.name,
    timezone,
    from,
    to,
    generatedAt: now.toISOString(),
    noShow,
    retention,
    completion,
    uptime,
    adoption,
    reviews,
    agent,
  };
}
