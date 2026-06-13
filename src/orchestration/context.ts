/**
 * RunContext factory (Wave 2c).
 *
 * Builds the per-run execution context handed to every pipeline stage:
 * resolved config, a level-scoped logger, an injectable clock, the dry-run
 * flag (mirrors `config.pr.dryRun`), and an opaque run id for correlation.
 */

import type { AgentConfig, RunContext } from '../contracts/index.js';
import { createLogger, randomId } from '../core/index.js';

/** Build a RunContext for a single scan. */
export function createRunContext(config: AgentConfig): RunContext {
  return {
    config,
    logger: createLogger({ level: config.logLevel }),
    now: () => new Date(),
    dryRun: config.pr.dryRun,
    runId: randomId('run'),
  };
}
