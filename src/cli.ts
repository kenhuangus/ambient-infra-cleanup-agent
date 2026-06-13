/**
 * CLI entry point (Wave 2c).
 *
 * Parses simple flags, loads config, assembles the enabled domain modules via
 * the locked factories, runs a single scan, and prints the run report.
 *
 *   infra-cleanup [--config <path>] [--dry-run] [--once]
 *
 * `--once` is the default (single run). `--dry-run` forces report-only mode.
 */

import type { AgentConfig, Detector, Recommender, SafetyAnalyzer } from './contracts/index.js';
import { createDbtModule } from './dbt/index.js';
import { createK8sModule } from './k8s/index.js';
import type { PipelineModules, RunReport } from './orchestration/index.js';
import {
  createGithubPrGenerator,
  createRunContext,
  createRunner,
  createStateStore,
  loadConfig,
} from './orchestration/index.js';

interface CliArgs {
  config?: string;
  dryRun: boolean;
  once: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let config: string | undefined;
  let dryRun = false;
  let once = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      config = argv[i + 1];
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--once') {
      once = true;
    }
  }
  return { ...(config === undefined ? {} : { config }), dryRun, once };
}

function assembleModules(config: AgentConfig): PipelineModules {
  const detectors: Detector[] = [];
  const analyzers: SafetyAnalyzer[] = [];
  const recommenders: Recommender[] = [];

  for (const domain of config.enabledDomains) {
    const module = domain === 'dbt' ? createDbtModule() : createK8sModule();
    detectors.push(module.detector);
    analyzers.push(module.analyzer);
    recommenders.push(module.recommender);
  }

  return {
    detectors,
    analyzers,
    recommenders,
    prGenerator: createGithubPrGenerator(),
  };
}

function printReport(report: RunReport): void {
  const lines: string[] = [];
  lines.push(
    `Run ${report.runId} — ${report.dryRun ? 'DRY-RUN (report only)' : 'LIVE'}`,
  );
  lines.push(`  started:  ${report.startedAt}`);
  lines.push(`  finished: ${report.finishedAt}`);
  for (const [domain, stat] of Object.entries(report.stats)) {
    lines.push(
      `  [${domain}] detected=${stat.detected} safe=${stat.safe} ` +
        `recommended=${stat.recommended} skipped=${stat.skipped}`,
    );
  }
  lines.push(`  Pull requests: ${report.prResults.length}`);
  for (const result of report.prResults) {
    const status = result.opened
      ? `opened${result.url ? ` ${result.url}` : ''}`
      : result.dryRun
        ? 'dry-run'
        : `not-opened${result.error ? ` (${result.error})` : ''}`;
    lines.push(`    - ${result.draft.title} [${status}]`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const baseConfig = await loadConfig(args.config);
  const config: AgentConfig = args.dryRun
    ? { ...baseConfig, pr: { ...baseConfig.pr, dryRun: true } }
    : baseConfig;

  const ctx = createRunContext(config);
  const modules = assembleModules(config);
  const stateStore = createStateStore();

  const report = await createRunner(ctx, modules, stateStore).run();
  printReport(report);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(1);
  });
