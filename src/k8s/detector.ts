/**
 * Kubernetes overprovisioning detector (Wave 2b).
 *
 * Flags workloads whose proposed request (percentile usage + buffer, floored at
 * `minMemoryMiB`) is meaningfully below the current request. Skips excluded
 * namespaces and workloads with too few samples. Does NOT judge OOM/restart
 * safety — that is the SafetyAnalyzer's job.
 */

import type {
  Detector,
  Domain,
  Evidence,
  Finding,
  RunContext,
  Severity,
} from '../contracts/index.js';
import { stableId } from '../core/index.js';

import { loadK8sMetrics } from './connectors/metrics.js';
import { sizeWorkload } from './sizing.js';

export class K8sDetector implements Detector {
  readonly domain: Domain = 'kubernetes';

  async detect(ctx: RunContext): Promise<Finding[]> {
    const log = ctx.logger.child({ domain: this.domain, stage: 'detect' });
    const metrics = await loadK8sMetrics(ctx);
    const thresholds = ctx.config.k8s;
    const excluded = new Set(ctx.config.excludedNamespaces);
    const detectedAt = ctx.now().toISOString();
    const findings: Finding[] = [];

    for (const metric of metrics) {
      if (excluded.has(metric.namespace)) {
        log.debug('skip: excluded namespace', {
          workload: metric.workload,
          namespace: metric.namespace,
        });
        continue;
      }

      const sizing = sizeWorkload(metric, thresholds);
      if (!sizing.hasSufficientSamples) {
        log.debug('skip: insufficient samples', {
          workload: metric.workload,
          sampleCount: sizing.sampleCount,
        });
        continue;
      }

      if (sizing.savingsMiB <= 0) {
        log.debug('skip: not overprovisioned', { workload: metric.workload });
        continue;
      }

      if (sizing.savingsFraction < thresholds.minSavingsFraction) {
        log.debug('skip: savings below threshold', {
          workload: metric.workload,
          savingsFraction: sizing.savingsFraction,
        });
        continue;
      }

      const signals: Evidence[] = [
        {
          kind: 'k8s-utilization',
          summary:
            `p${thresholds.percentile} usage ${round(sizing.usageAtPercentileMiB)}MiB ` +
            `vs request ${metric.requestMemory} (${round(sizing.requestMiB)}MiB)`,
          data: {
            percentile: thresholds.percentile,
            usageAtPercentileMiB: round(sizing.usageAtPercentileMiB),
            requestMiB: round(sizing.requestMiB),
            proposedMiB: sizing.proposedMiB,
            sampleCount: sizing.sampleCount,
          },
        },
        {
          kind: 'k8s-savings',
          summary:
            `could free ~${sizing.savingsMiB}MiB ` +
            `(${pct(sizing.savingsFraction)} of request)`,
          data: {
            savingsMiB: sizing.savingsMiB,
            savingsFraction: sizing.savingsFraction,
          },
        },
        {
          kind: 'k8s-stability',
          summary:
            `restarts=${metric.restarts}, oomKills=${metric.oomKills}` +
            (metric.lastOomAt === undefined ? '' : `, lastOomAt=${metric.lastOomAt}`),
          data: {
            restarts: metric.restarts,
            oomKills: metric.oomKills,
            ...(metric.lastOomAt === undefined ? {} : { lastOomAt: metric.lastOomAt }),
            usageCv: round(sizing.usageCv * 100) / 100,
          },
        },
      ];

      findings.push({
        id: stableId('k8s', metric.workload, metric.container),
        domain: this.domain,
        targetRef: metric.workload,
        title: `Overprovisioned memory: ${metric.workload}/${metric.container}`,
        severity: severityFor(sizing.savingsFraction),
        signals,
        detectedAt,
      });
    }

    log.info('detection complete', {
      candidates: findings.length,
      evaluated: metrics.length,
    });
    return findings;
  }
}

function severityFor(savingsFraction: number): Severity {
  if (savingsFraction >= 0.4) return 'high';
  if (savingsFraction >= 0.25) return 'medium';
  return 'low';
}

function round(value: number): number {
  return Math.round(value);
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
