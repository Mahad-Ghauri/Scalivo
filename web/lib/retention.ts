import { CAMPAIGN_AUDIENCE, type CampaignAudience } from '@scalivo/shared';

/**
 * How the two retention audiences are described to an owner — SPEC §6.
 *
 * In a plain module rather than beside the composer, because both the server
 * page and the client components need it: a non-component export from a
 * `'use client'` file reaches a server component as a client reference, not as
 * the object, and reading a property off it is a runtime crash rather than a
 * type error.
 *
 * Neither label says "at risk" or "lapsed". Those are the CRM's words for a
 * behaviour, and an owner about to message these people needs to know who they
 * are, not which bucket they fell into.
 */
export const AUDIENCE_COPY: Record<CampaignAudience, { label: string; who: string }> = {
  [CAMPAIGN_AUDIENCE.LAPSED]: {
    label: 'Lapsed customers',
    who: 'people who have not been in for three months or more',
  },
  [CAMPAIGN_AUDIENCE.AT_RISK]: {
    label: 'Customers slipping away',
    who: 'people who are overdue compared to how often they usually come',
  },
};
