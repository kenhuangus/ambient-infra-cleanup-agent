/**
 * Shared workload-sizing math (Wave 2b).
 *
 * The detector, analyzer, and recommender must agree on the proposed request
 * and savings for a workload, so that logic lives here in one place.
 */

import type { K8sThresholds } from '../contracts/index.js';
import type { K8sWorkloadMetric } from './connectors/metrics.js';
import { mean, parseMemToMiB, percentile, stdev } from './units.js';

/** Minimum number of usage samples required to size a workload confidently. */
export const MIN_SAMPLES = 5;

export interface WorkloadSizing {
  /** Current memory request in MiB. */
  requestMiB: number;
  /** Current memory limit in MiB, if the workload declares one. */
  limitMiB?: number;
  /** Usage at the configured percentile (MiB). */
  usageAtPercentileMiB: number;
  /** Raw proposed request before applying the floor (MiB). */
  rawProposedMiB: number;
  /** Proposed request after flooring at `minMemoryMiB` (MiB). */
  proposedMiB: number;
  /** Whether the proposal was clamped up to the floor. */
  atFloor: boolean;
  /** MiB saved vs the current request (0 if proposal >= request). */
  savingsMiB: number;
  /** Fraction of the current request saved (0..1, 0 if no savings). */
  savingsFraction: number;
  /** Number of usage samples provided. */
  sampleCount: number;
  /** Whether enough samples exist to size confidently. */
  hasSufficientSamples: boolean;
  /** Coefficient of variation of usage (stdev/mean); lower is more stable. */
  usageCv: number;
}

/** Compute the proposed request + savings for a workload metric. */
export function sizeWorkload(
  metric: K8sWorkloadMetric,
  thresholds: K8sThresholds,
): WorkloadSizing {
  const requestMiB = parseMemToMiB(metric.requestMemory);
  const limitMiB =
    metric.limitMemory === undefined ? undefined : parseMemToMiB(metric.limitMemory);

  const samples = metric.usageSamplesMiB;
  const sampleCount = samples.length;
  const usageAtPercentileMiB = percentile(samples, thresholds.percentile);

  const rawProposedMiB = Math.ceil(
    usageAtPercentileMiB * (1 + thresholds.bufferPct / 100),
  );
  const proposedMiB = Math.max(thresholds.minMemoryMiB, rawProposedMiB);

  const savingsMiB = proposedMiB < requestMiB ? requestMiB - proposedMiB : 0;
  const savingsFraction = requestMiB > 0 ? savingsMiB / requestMiB : 0;

  const usageMean = mean(samples);
  const usageCv = usageMean > 0 ? stdev(samples) / usageMean : 0;

  return {
    requestMiB,
    ...(limitMiB === undefined ? {} : { limitMiB }),
    usageAtPercentileMiB,
    rawProposedMiB,
    proposedMiB,
    atFloor: proposedMiB > rawProposedMiB,
    savingsMiB,
    savingsFraction,
    sampleCount,
    hasSufficientSamples: sampleCount >= MIN_SAMPLES,
    usageCv,
  };
}
