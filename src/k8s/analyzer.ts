/**
 * Kubernetes safety analyzer (Wave 2b).
 *
 * Decides whether an overprovisioned workload is safe to resize. Blocks on
 * recent OOM kills, high restart counts, insufficient samples, or a proposal
 * that would dip below the configured memory floor. Confidence rises with more
 * samples and more stable usage.
 */

import type {
  Domain,
  Evidence,
  Finding,
  RunContext,
  SafetyAnalyzer,
  SafetyAssessment,
} from '../contracts/index.js';
import { clamp01, confidence } from '../core/index.js';

import { loadK8sMetrics, type K8sWorkloadMetric } from './connectors/metrics.js';
import { MIN_SAMPLES, sizeWorkload } from './sizing.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class K8sSafetyAnalyzer implements SafetyAnalyzer {
  readonly domain: Domain = 'kubernetes';

  async assess(finding: Finding, ctx: RunContext): Promise<SafetyAssessment> {
    const log = ctx.logger.child({ domain: this.domain, stage: 'assess' });
    const metrics = await loadK8sMetrics(ctx);
    const metric = metrics.find((m) => m.workload === finding.targetRef);

    if (metric === undefined) {
      return {
        safe: false,
        confidence: confidence(0, 'no metric found for finding target'),
        reasons: [],
        blockers: [`no utilization metric found for ${finding.targetRef}`],
      };
    }

    const thresholds = ctx.config.k8s;
    const sizing = sizeWorkload(metric, thresholds);
    const blockers: string[] = [];
    const reasons: Evidence[] = [];

    // --- OOM recency -------------------------------------------------------
    const oomDays = daysSinceOom(metric, ctx.now());
    if (oomDays !== undefined && oomDays <= thresholds.recentOomDays) {
      blockers.push(
        `recent OOM kill ${oomDays.toFixed(1)}d ago ` +
          `(within ${thresholds.recentOomDays}d window)`,
      );
    } else if (metric.oomKills > 0 && oomDays === undefined) {
      blockers.push(
        `${metric.oomKills} OOM kill(s) recorded with unknown recency`,
      );
    } else {
      reasons.push({
        kind: 'k8s-no-recent-oom',
        summary:
          oomDays === undefined
            ? 'no OOM kills recorded'
            : `last OOM ${oomDays.toFixed(1)}d ago (outside ${thresholds.recentOomDays}d window)`,
        data: { oomKills: metric.oomKills, ...(oomDays === undefined ? {} : { oomDaysAgo: oomDays }) },
      });
    }

    // --- Restart rate ------------------------------------------------------
    if (metric.restarts > thresholds.maxRestarts) {
      blockers.push(
        `restart count ${metric.restarts} exceeds max ${thresholds.maxRestarts}`,
      );
    } else {
      reasons.push({
        kind: 'k8s-restarts-ok',
        summary: `restarts ${metric.restarts} <= max ${thresholds.maxRestarts}`,
        data: { restarts: metric.restarts },
      });
    }

    // --- Sample sufficiency ------------------------------------------------
    if (!sizing.hasSufficientSamples) {
      blockers.push(
        `insufficient samples: ${sizing.sampleCount} < ${MIN_SAMPLES} required`,
      );
    } else {
      reasons.push({
        kind: 'k8s-samples',
        summary: `${sizing.sampleCount} usage samples available`,
        data: { sampleCount: sizing.sampleCount },
      });
    }

    // --- Floor check -------------------------------------------------------
    if (sizing.rawProposedMiB < thresholds.minMemoryMiB) {
      blockers.push(
        `proposed request ${sizing.rawProposedMiB}MiB would fall below ` +
          `floor ${thresholds.minMemoryMiB}MiB`,
      );
    }

    const conf = scoreConfidence(sizing.sampleCount, sizing.usageCv, blockers.length);
    const safe = blockers.length === 0;

    log.debug('assessment complete', {
      workload: metric.workload,
      safe,
      blockers: blockers.length,
      confidence: conf.score,
    });

    return { safe, confidence: conf, reasons, blockers };
  }
}

/** Days between the last OOM and `now`, or undefined when no OOM is recorded. */
function daysSinceOom(metric: K8sWorkloadMetric, now: Date): number | undefined {
  if (metric.lastOomAt === undefined) return undefined;
  const oomTime = Date.parse(metric.lastOomAt);
  if (Number.isNaN(oomTime)) return undefined;
  return (now.getTime() - oomTime) / MS_PER_DAY;
}

/**
 * Confidence rises with sample count (saturating around 2x the minimum) and
 * with usage stability (low coefficient of variation). Blockers cap the score
 * so an unsafe assessment never reports high confidence in "safety".
 */
function scoreConfidence(
  sampleCount: number,
  usageCv: number,
  blockerCount: number,
): ReturnType<typeof confidence> {
  const sampleScore = clamp01(sampleCount / (MIN_SAMPLES * 2));
  const stabilityScore = clamp01(1 - usageCv);
  let score = 0.5 * sampleScore + 0.5 * stabilityScore;
  if (blockerCount > 0) {
    score = Math.min(score, 0.3);
  }
  const rationale =
    `samples=${sampleCount} (score ${sampleScore.toFixed(2)}), ` +
    `usageCv=${usageCv.toFixed(2)} (stability ${stabilityScore.toFixed(2)})` +
    (blockerCount > 0 ? `, capped by ${blockerCount} blocker(s)` : '');
  return confidence(score, rationale);
}
