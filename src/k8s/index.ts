/**
 * Wave 2b entry point — Kubernetes memory right-sizing loop.
 *
 * OWNED BY: Wave 2b. The `K8sModule` shape and the `createK8sModule` factory
 * signature are LOCKED so the orchestrator (Wave 2c) can wire it. Per-run
 * config/logger/clock arrive via `RunContext` on each stage call.
 *
 * Pipeline:
 *  - K8sDetector:         read utilization metrics (mockable connector) and flag
 *                         overprovisioned workloads against k8s thresholds.
 *  - K8sSafetyAnalyzer:   guard on recent OOMs, restart rate, insufficient data,
 *                         and the memory floor.
 *  - K8sMemoryRecommender: emit `k8s-memory-resize` Recommendations editing
 *                         manifests under `manifestsDir`.
 */

import type { Detector, Recommender, SafetyAnalyzer } from '../contracts/index.js';

import { K8sSafetyAnalyzer } from './analyzer.js';
import { K8sDetector } from './detector.js';
import { K8sMemoryRecommender } from './recommender.js';

export interface K8sModule {
  detector: Detector;
  analyzer: SafetyAnalyzer;
  recommender: Recommender;
}

/**
 * Factory the orchestrator imports to obtain the k8s pipeline stages.
 * Per-run config/logger arrive via `RunContext` on each stage call.
 */
export function createK8sModule(): K8sModule {
  return {
    detector: new K8sDetector(),
    analyzer: new K8sSafetyAnalyzer(),
    recommender: new K8sMemoryRecommender(),
  };
}

export { K8sDetector } from './detector.js';
export { K8sSafetyAnalyzer } from './analyzer.js';
export { K8sMemoryRecommender } from './recommender.js';
