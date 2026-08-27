/**
 * Behavioural tags, auto-assigned from booking events and a nightly recompute.
 * Never set by hand — they drive the retention engine and the agent.
 */
export const CLIENT_TAG = {
  NEW: 'new',
  VIP: 'vip',
  AT_RISK: 'at_risk',
  LAPSED: 'lapsed',
} as const;

export type ClientTag = (typeof CLIENT_TAG)[keyof typeof CLIENT_TAG];

// Thresholds are hard-coded in the tagging job until a pilot actually disagrees
// with one. Make them per-business config then, not before.
