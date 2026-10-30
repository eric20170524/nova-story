export type GrokDurationDecision = {
  action: 'deliver' | 'review' | 'reject';
  reason?: string;
};

/** Near-target clips can be standardized. Other finite clips stay reviewable. Nonsense lengths fail. */
export function classifyGrokSourceDuration(seconds: number, targetSeconds = 5): GrokDurationDecision {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 15) {
    return {
      action: 'reject',
      reason: `Grok returned ${seconds}s; a delivery clip must be near ${targetSeconds} seconds.`,
    };
  }
  if (Math.abs(seconds - targetSeconds) > 0.25) {
    return {
      action: 'review',
      reason: `Grok returned ${seconds}s for a ${targetSeconds}s request; manual review is required before delivery.`,
    };
  }
  return { action: 'deliver' };
}
