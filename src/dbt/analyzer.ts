/**
 * dbt safety analyzer — decides whether a flagged model is safe to deprecate or
 * should only be flagged for human review. Conservative by design: any active
 * downstream dependency, exposure, metric, or recent read is a hard blocker.
 */

import type {
  Evidence,
  Finding,
  RunContext,
  SafetyAnalyzer,
  SafetyAssessment,
} from '../contracts/index.js';
import { confidence } from '../core/index.js';
import { analyzeModel, type ModelAnalysis } from './analysis.js';
import { loadDbtData } from './connectors/index.js';

function collectBlockers(analysis: ModelAnalysis, staleDays: number): string[] {
  const blockers: string[] = [];

  if (analysis.directDownstreamModels.length > 0) {
    blockers.push(`has ${analysis.directDownstreamModels.length} downstream dbt model(s)`);
  }
  const transitiveOnly = analysis.transitiveDownstreamModels.filter(
    (id) => !analysis.directDownstreamModels.includes(id),
  );
  if (transitiveOnly.length > 0) {
    blockers.push(`has ${transitiveOnly.length} transitive downstream model(s)`);
  }
  if (analysis.exposures.length > 0) {
    blockers.push(`referenced by ${analysis.exposures.length} exposure(s)`);
  }
  if (analysis.metrics.length > 0) {
    blockers.push(`referenced by ${analysis.metrics.length} metric(s)`);
  }
  if (analysis.daysSinceRead !== undefined && analysis.daysSinceRead < staleDays) {
    blockers.push(
      `read ${analysis.readCount} time(s) within the last ${staleDays}d (${analysis.daysSinceRead}d ago)`,
    );
  }

  return blockers;
}

function buildReasons(analysis: ModelAnalysis): Evidence[] {
  return [
    {
      kind: 'dbt-downstream',
      summary: `${analysis.directDownstreamModels.length} direct / ${analysis.transitiveDownstreamModels.length} transitive downstream model(s)`,
      data: {
        direct: analysis.directDownstreamModels,
        transitive: analysis.transitiveDownstreamModels,
      },
    },
    {
      kind: 'dbt-consumers',
      summary: `${analysis.exposures.length} exposure(s), ${analysis.metrics.length} metric(s), ${analysis.tests.length} test(s)`,
      data: {
        exposures: analysis.exposures.map((exposure) => exposure.uniqueId),
        metrics: analysis.metrics,
        tests: analysis.tests,
      },
    },
    {
      kind: 'snowflake-recency',
      summary:
        analysis.lastReadAt === undefined
          ? 'no reads observed in window'
          : `last read ${analysis.daysSinceRead ?? 0}d ago`,
      data: {
        lastReadAt: analysis.lastReadAt?.toISOString(),
        daysSinceRead: analysis.daysSinceRead,
        readCount: analysis.readCount,
      },
    },
  ];
}

function scoreFor(safe: boolean, analysis: ModelAnalysis, blockerCount: number): number {
  if (safe) {
    // Strongest when nothing reads it and it has no dependents.
    return analysis.lastReadAt === undefined ? 0.92 : 0.82;
  }
  return Math.max(0.1, 0.4 - 0.1 * (blockerCount - 1));
}

export class DbtSafetyAnalyzer implements SafetyAnalyzer {
  public readonly domain = 'dbt' as const;

  public async assess(finding: Finding, ctx: RunContext): Promise<SafetyAssessment> {
    const log = ctx.logger.child({ domain: 'dbt', stage: 'assess', runId: ctx.runId });
    const data = await loadDbtData(ctx);
    const model = data.artifacts.getModel(finding.targetRef);

    if (model === undefined) {
      log.warn('model referenced by finding not found in manifest', {
        targetRef: finding.targetRef,
      });
      return {
        safe: false,
        confidence: confidence(0.1, 'model not found in dbt manifest'),
        reasons: [
          {
            kind: 'missing-model',
            summary: `model ${finding.targetRef} not present in current manifest`,
          },
        ],
        blockers: ['model not found in dbt manifest'],
      };
    }

    const analysis = analyzeModel(model, data, ctx);
    const blockers = collectBlockers(analysis, ctx.config.dbt.staleDays);
    const safe = blockers.length === 0;
    const score = scoreFor(safe, analysis, blockers.length);
    const rationale = safe
      ? 'no downstream dependents, exposures, metrics, or recent reads'
      : `blocked by: ${blockers.join('; ')}`;

    log.debug('dbt safety assessed', { model: model.uniqueId, safe, blockers });

    return {
      safe,
      confidence: confidence(score, rationale),
      reasons: buildReasons(analysis),
      blockers,
    };
  }
}
