/**
 * dbt detector — flags stale / low-usage / orphaned models as cleanup
 * candidates by combining dbt artifacts with Snowflake read usage.
 */

import type {
  Detector,
  Evidence,
  Finding,
  RunContext,
  Severity,
} from '../contracts/index.js';
import { stableId } from '../core/index.js';
import {
  analyzeModel,
  hasNoDownstream,
  isExcluded,
  isLowReads,
  isStaleByReads,
  type ModelAnalysis,
} from './analysis.js';
import { loadDbtData } from './connectors/index.js';

interface CandidateReasons {
  staleByReads: boolean;
  lowReads: boolean;
  orphaned: boolean;
}

function evaluate(analysis: ModelAnalysis, ctx: RunContext): CandidateReasons {
  const { dbt } = ctx.config;
  return {
    staleByReads: isStaleByReads(analysis, dbt.staleDays),
    lowReads: isLowReads(analysis, dbt.lowReadCountPerDays),
    orphaned: dbt.flagWithoutDownstream && hasNoDownstream(analysis),
  };
}

function lastReadSummary(analysis: ModelAnalysis): string {
  if (analysis.lastReadAt === undefined) return 'never read in the observed window';
  return `last read ${analysis.daysSinceRead ?? 0}d ago (${analysis.lastReadAt.toISOString()})`;
}

function buildSignals(analysis: ModelAnalysis, reasons: CandidateReasons): Evidence[] {
  const signals: Evidence[] = [];

  signals.push({
    kind: 'snowflake-usage',
    summary: `${analysis.readCount} read(s) over ${analysis.windowDays}d; ${lastReadSummary(analysis)}`,
    data: {
      readCount: analysis.readCount,
      windowDays: analysis.windowDays,
      lastReadAt: analysis.lastReadAt?.toISOString(),
      daysSinceRead: analysis.daysSinceRead,
      monthlyComputeUsd: analysis.monthlyComputeUsd,
    },
  });

  signals.push({
    kind: 'dbt-lineage',
    summary: `${analysis.directDownstreamModels.length} direct downstream model(s), ${analysis.exposures.length} exposure(s)`,
    data: {
      directDownstreamModels: analysis.directDownstreamModels,
      transitiveDownstreamModels: analysis.transitiveDownstreamModels,
      exposures: analysis.exposures.map((exposure) => exposure.uniqueId),
      metrics: analysis.metrics,
      tests: analysis.tests,
    },
  });

  if (analysis.lastMaterializedAt !== undefined) {
    signals.push({
      kind: 'dbt-materialization',
      summary: `last materialized ${analysis.daysSinceMaterialized ?? 0}d ago (${analysis.lastMaterializedAt.toISOString()})`,
      data: {
        lastMaterializedAt: analysis.lastMaterializedAt.toISOString(),
        daysSinceMaterialized: analysis.daysSinceMaterialized,
      },
    });
  }

  const tripped: string[] = [];
  if (reasons.staleByReads) tripped.push('no reads within stale window');
  if (reasons.lowReads) tripped.push('read count below low-usage threshold');
  if (reasons.orphaned) tripped.push('no downstream models or exposures');
  signals.push({
    kind: 'detection-reasons',
    summary: `triggered: ${tripped.join('; ')}`,
    data: { ...reasons },
  });

  return signals;
}

function severityFor(reasons: CandidateReasons): Severity {
  if (reasons.staleByReads && reasons.orphaned) return 'high';
  if (reasons.staleByReads) return 'medium';
  return 'low';
}

function titleFor(analysis: ModelAnalysis, reasons: CandidateReasons): string {
  if (reasons.staleByReads && reasons.orphaned) {
    return `dbt model "${analysis.model.name}" is stale and has no downstream usage`;
  }
  if (reasons.staleByReads) {
    return `dbt model "${analysis.model.name}" has no recent reads`;
  }
  if (reasons.lowReads) {
    return `dbt model "${analysis.model.name}" has low read usage`;
  }
  return `dbt model "${analysis.model.name}" has no downstream usage`;
}

export class DbtDetector implements Detector {
  public readonly domain = 'dbt' as const;

  public async detect(ctx: RunContext): Promise<Finding[]> {
    const log = ctx.logger.child({ domain: 'dbt', stage: 'detect', runId: ctx.runId });
    const data = await loadDbtData(ctx);
    const models = data.artifacts.listModels();
    const findings: Finding[] = [];

    for (const model of models) {
      if (isExcluded(model, ctx.config.excludedDbtModels)) {
        log.debug('skipping excluded dbt model', { model: model.uniqueId });
        continue;
      }

      const analysis = analyzeModel(model, data, ctx);
      const reasons = evaluate(analysis, ctx);
      const isCandidate = reasons.staleByReads || reasons.lowReads || reasons.orphaned;
      if (!isCandidate) continue;

      findings.push({
        id: stableId('dbt', model.uniqueId),
        domain: 'dbt',
        targetRef: model.uniqueId,
        title: titleFor(analysis, reasons),
        severity: severityFor(reasons),
        signals: buildSignals(analysis, reasons),
        detectedAt: ctx.now().toISOString(),
      });
    }

    log.info('dbt detection complete', {
      scanned: models.length,
      candidates: findings.length,
    });
    return findings;
  }
}
