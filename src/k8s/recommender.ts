/**
 * Kubernetes memory right-sizing recommender (Wave 2b).
 *
 * Turns a safe, overprovisioned finding into a `k8s-memory-resize`
 * Recommendation: a requests-only manifest edit (via the manifest connector),
 * an impact estimate in MiB, and plain-language rollback. Returns null when the
 * finding is unsafe or savings fall below the configured threshold.
 */

import type {
  Domain,
  FileChange,
  Finding,
  ImpactEstimate,
  K8sMemoryResizeAction,
  Recommendation,
  Recommender,
  RunContext,
  SafetyAssessment,
} from '../contracts/index.js';
import { stableId } from '../core/index.js';

import { loadK8sMetrics } from './connectors/metrics.js';
import {
  editManifestMemoryRequest,
  manifestRepoPath,
  readManifest,
} from './connectors/manifests.js';
import { sizeWorkload } from './sizing.js';
import { formatMiB } from './units.js';

export class K8sMemoryRecommender implements Recommender {
  readonly domain: Domain = 'kubernetes';

  async recommend(
    finding: Finding,
    assessment: SafetyAssessment,
    ctx: RunContext,
  ): Promise<Recommendation | null> {
    const log = ctx.logger.child({ domain: this.domain, stage: 'recommend' });

    if (!assessment.safe) {
      log.debug('skip: assessment not safe', { workload: finding.targetRef });
      return null;
    }

    const metrics = await loadK8sMetrics(ctx);
    const metric = metrics.find((m) => m.workload === finding.targetRef);
    if (metric === undefined) {
      log.warn('skip: no metric for finding', { workload: finding.targetRef });
      return null;
    }

    const thresholds = ctx.config.k8s;
    const sizing = sizeWorkload(metric, thresholds);
    if (sizing.savingsMiB <= 0 || sizing.savingsFraction < thresholds.minSavingsFraction) {
      log.debug('skip: savings below threshold', {
        workload: metric.workload,
        savingsFraction: sizing.savingsFraction,
      });
      return null;
    }

    const proposedRequest = formatMiB(sizing.proposedMiB);
    const repoPath = manifestRepoPath(ctx, metric.manifestPath);

    const manifestText = await readManifest(ctx, metric.manifestPath);
    const edit = editManifestMemoryRequest(
      manifestText,
      metric.container,
      proposedRequest,
    );

    const change: FileChange = {
      path: repoPath,
      kind: 'modify',
      description:
        `Lower memory request for container "${metric.container}" in ` +
        `${metric.workload} from ${metric.requestMemory} to ${proposedRequest} ` +
        `(p${thresholds.percentile} usage ${Math.round(sizing.usageAtPercentileMiB)}MiB ` +
        `+ ${thresholds.bufferPct}% buffer).`,
      newContent: edit.content,
    };

    const action: K8sMemoryResizeAction = {
      type: 'k8s-memory-resize',
      workload: metric.workload,
      container: metric.container,
      currentRequest: metric.requestMemory,
      proposedRequest,
      // Requests-only for the MVP: limits are intentionally left untouched.
      changes: [change],
    };

    const estimatedImpact: ImpactEstimate = {
      description:
        `Frees ~${sizing.savingsMiB}MiB of requested memory on ${metric.workload} ` +
        `(${Math.round(sizing.savingsFraction * 100)}% of the current request).`,
      metric: 'memory-mib',
      estimatedValue: sizing.savingsMiB,
      unit: 'MiB',
    };

    const rollback =
      `Revert this PR (or set the "${metric.container}" memory request in ` +
      `${repoPath} back to ${metric.requestMemory}) to restore the original ` +
      `memory allocation.`;

    log.info('recommendation produced', {
      workload: metric.workload,
      proposedRequest,
      savingsMiB: sizing.savingsMiB,
    });

    return {
      id: stableId('k8s-rec', finding.id, proposedRequest),
      finding,
      assessment,
      action,
      estimatedImpact,
      rollback,
    };
  }
}
