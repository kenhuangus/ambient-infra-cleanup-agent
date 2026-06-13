/**
 * Wave 2c entry point — orchestration: config loading, state store, GitHub PR
 * generation, and the runner that wires the pipeline together.
 *
 * OWNED BY: Wave 2c. The exported factory signatures and the
 * `PipelineModules` / `DomainRunStats` / `RunReport` / `Runner` interfaces are
 * LOCKED so `src/cli.ts` and tests can depend on them.
 */

import type {
  Detector,
  PrGenerationResult,
  PrGenerator,
  Recommender,
  SafetyAnalyzer,
} from '../contracts/index.js';

/** The Wave 2 modules the runner wires together. */
export interface PipelineModules {
  detectors: Detector[];
  analyzers: SafetyAnalyzer[];
  recommenders: Recommender[];
  prGenerator: PrGenerator;
}

/** Per-domain counts in a run summary. */
export interface DomainRunStats {
  detected: number;
  safe: number;
  recommended: number;
  skipped: number;
}

/** End-of-run summary report (PRD: "summary report of findings ... and PRs"). */
export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  stats: Record<string, DomainRunStats>;
  prResults: PrGenerationResult[];
}

/** The thing the CLI invokes once per scan. */
export interface Runner {
  run(): Promise<RunReport>;
}

export { loadConfig } from './config.js';
export { createRunContext } from './context.js';
export { createStateStore } from './state.js';
export { createGithubPrGenerator } from './prGenerator.js';
export { createRunner } from './runner.js';
