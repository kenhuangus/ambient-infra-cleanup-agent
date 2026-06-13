/**
 * dbt recommender — turns a safe / reviewable candidate into a concrete
 * `dbt-deprecate` recommendation with a surgical FileChange, rollback notes,
 * and an estimated compute-cost impact. Returns null when nothing sensible can
 * be proposed (e.g. an unsafe model that is still actively read).
 */

import type {
  DbtDeprecateAction,
  FileChange,
  Finding,
  ImpactEstimate,
  Recommendation,
  Recommender,
  RunContext,
  SafetyAssessment,
} from '../contracts/index.js';
import { stableId } from '../core/index.js';
import { analyzeModel, type ModelAnalysis } from './analysis.js';
import { loadDbtData } from './connectors/index.js';

const DEPRECATION_WINDOW_DAYS = 90;

type DeprecationMode = DbtDeprecateAction['mode'];

function hasLineageConcern(analysis: ModelAnalysis): boolean {
  return (
    analysis.directDownstreamModels.length > 0 ||
    analysis.transitiveDownstreamModels.length > 0 ||
    analysis.exposures.length > 0 ||
    analysis.metrics.length > 0
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function targetPath(analysis: ModelAnalysis): string {
  const original = analysis.model.originalFilePath;
  if (original.length > 0) return original;
  if (analysis.model.path.length > 0) return `models/${analysis.model.path}`;
  return `models/${analysis.model.name}.sql`;
}

function deprecatePatch(path: string, runDate: string, removalDate: string): string {
  const body = [
    `-- DEPRECATION: flagged by ambient-infra-cleanup-agent on ${runDate}.`,
    '-- No Snowflake reads within the stale window and no downstream models or exposures.',
    `-- Scheduled for removal on or after ${removalDate} unless an owner objects.`,
    `{{ config(meta={'deprecated': true, 'deprecation_date': '${removalDate}'}) }}`,
  ];
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${body.length} @@`,
    ...body.map((line) => `+${line}`),
  ].join('\n');
}

function flagPatch(path: string, runDate: string, blockers: string[]): string {
  const body = [
    `-- REVIEW REQUESTED: flagged by ambient-infra-cleanup-agent on ${runDate}.`,
    '-- Low/stale usage, but removal is blocked by active dependents:',
    ...blockers.map((blocker) => `--   - ${blocker}`),
    `{{ config(meta={'deprecation_candidate': true, 'review_requested': '${runDate}'}) }}`,
  ];
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${body.length} @@`,
    ...body.map((line) => `+${line}`),
  ].join('\n');
}

function buildChange(
  mode: DeprecationMode,
  analysis: ModelAnalysis,
  assessment: SafetyAssessment,
  ctx: RunContext,
): FileChange {
  const path = targetPath(analysis);
  const runDate = isoDate(ctx.now());

  if (mode === 'flag-for-review') {
    return {
      path,
      kind: 'modify',
      description: `Annotate "${analysis.model.name}" as a deprecation candidate for owner review (does not change how it builds).`,
      patch: flagPatch(path, runDate, assessment.blockers),
    };
  }

  const removalDate = isoDate(
    new Date(ctx.now().getTime() + DEPRECATION_WINDOW_DAYS * 86_400_000),
  );
  return {
    path,
    kind: 'modify',
    description: `Add dbt deprecation metadata to "${analysis.model.name}" (deprecation_date ${removalDate}); the model keeps building until a follow-up removal PR.`,
    patch: deprecatePatch(path, runDate, removalDate),
  };
}

function buildImpact(analysis: ModelAnalysis, mode: DeprecationMode): ImpactEstimate {
  const usd = analysis.monthlyComputeUsd;
  const verb = mode === 'deprecate' ? 'Deprecating' : 'Reviewing';
  if (usd === undefined) {
    return {
      description: `${verb} "${analysis.model.name}" reduces unused dbt build/storage footprint.`,
    };
  }
  return {
    description: `${verb} "${analysis.model.name}" can avoid ~$${usd.toFixed(2)}/month of Snowflake compute.`,
    metric: 'monthly-usd',
    estimatedValue: usd,
    unit: 'USD/month',
  };
}

function rollbackFor(mode: DeprecationMode): string {
  if (mode === 'flag-for-review') {
    return (
      'Revert this PR (or delete the added review/deprecation-candidate metadata). ' +
      'This change only annotates the model; it does not alter how it builds, so there is no data impact.'
    );
  }
  return (
    "Revert this PR (or remove the added `config(meta={'deprecated': true, ...})` block) to restore the model. " +
    'No tables are dropped — the model keeps materializing until a separate removal PR is merged after the deprecation window.'
  );
}

export class DbtRecommender implements Recommender {
  public readonly domain = 'dbt' as const;

  public async recommend(
    finding: Finding,
    assessment: SafetyAssessment,
    ctx: RunContext,
  ): Promise<Recommendation | null> {
    const log = ctx.logger.child({ domain: 'dbt', stage: 'recommend', runId: ctx.runId });
    const data = await loadDbtData(ctx);
    const model = data.artifacts.getModel(finding.targetRef);
    if (model === undefined) {
      log.warn('cannot recommend: model missing from manifest', {
        targetRef: finding.targetRef,
      });
      return null;
    }

    const analysis = analyzeModel(model, data, ctx);

    let mode: DeprecationMode;
    if (assessment.safe) {
      // Conservative MVP: safe + orphaned => deprecate (never auto-disable).
      mode = 'deprecate';
    } else if (hasLineageConcern(analysis)) {
      mode = 'flag-for-review';
    } else {
      // Unsafe for reasons other than lineage (e.g. still actively read):
      // proposing a touch is not sensible.
      log.info('no sensible recommendation; skipping', {
        model: model.uniqueId,
        blockers: assessment.blockers,
      });
      return null;
    }

    const action: DbtDeprecateAction = {
      type: 'dbt-deprecate',
      model: model.uniqueId,
      mode,
      changes: [buildChange(mode, analysis, assessment, ctx)],
    };

    log.info('dbt recommendation produced', { model: model.uniqueId, mode });

    return {
      id: stableId('dbt-rec', model.uniqueId, mode),
      finding,
      assessment,
      action,
      estimatedImpact: buildImpact(analysis, mode),
      rollback: rollbackFor(mode),
    };
  }
}
