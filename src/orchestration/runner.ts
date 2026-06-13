/**
 * Pipeline runner (Wave 2c).
 *
 * Wires Detectors → SafetyAnalyzers → Recommenders → PrGenerator per enabled
 * domain, deduplicating findings via the StateStore and tracking lifecycle
 * (detected → proposed). Emits a `RunReport` summary and a concise human log.
 */

import type {
  KnownFinding,
  Recommendation,
  RunContext,
  SafetyAssessment,
  StateStore,
} from '../contracts/index.js';
import type {
  DomainRunStats,
  PipelineModules,
  RunReport,
  Runner,
} from './index.js';

/** Compose the pipeline into a runnable scan. */
export function createRunner(
  ctx: RunContext,
  modules: PipelineModules,
  stateStore: StateStore,
): Runner {
  return {
    async run(): Promise<RunReport> {
      const { config, logger } = ctx;
      const startedAt = ctx.now().toISOString();
      const stats: Record<string, DomainRunStats> = {};
      const allRecs: Recommendation[] = [];

      for (const domain of config.enabledDomains) {
        const stat: DomainRunStats = {
          detected: 0,
          safe: 0,
          recommended: 0,
          skipped: 0,
        };
        const detectors = modules.detectors.filter((d) => d.domain === domain);
        const analyzers = modules.analyzers.filter((a) => a.domain === domain);
        const recommenders = modules.recommenders.filter(
          (r) => r.domain === domain,
        );

        for (const detector of detectors) {
          const findings = await detector.detect(ctx);
          for (const finding of findings) {
            stat.detected += 1;

            // Dedup / lifecycle upsert (state advances only via markState).
            const nowIso = ctx.now().toISOString();
            const existing = await stateStore.get(finding.id);
            const known: KnownFinding = {
              findingId: finding.id,
              domain: finding.domain,
              targetRef: finding.targetRef,
              state: existing?.state ?? 'detected',
              firstSeenAt: existing?.firstSeenAt ?? finding.detectedAt ?? nowIso,
              lastSeenAt: nowIso,
              ...(existing?.prDraftId ? { prDraftId: existing.prDraftId } : {}),
              ...(existing?.prUrl ? { prUrl: existing.prUrl } : {}),
            };
            await stateStore.record([known]);

            // Assess with the first matching analyzer for the domain.
            const analyzer = analyzers[0];
            if (analyzer === undefined) {
              stat.skipped += 1;
              continue;
            }
            const assessment: SafetyAssessment = await analyzer.assess(
              finding,
              ctx,
            );
            if (assessment.safe) stat.safe += 1;

            // Recommend (recommenders may return null => nothing to propose).
            let recommended = false;
            for (const recommender of recommenders) {
              const rec = await recommender.recommend(finding, assessment, ctx);
              if (rec !== null) {
                allRecs.push(rec);
                recommended = true;
              }
            }
            if (recommended) stat.recommended += 1;
            else stat.skipped += 1;
          }
        }

        stats[domain] = stat;
      }

      // Batch + (dry-run aware) open PRs, then advance lifecycle.
      const prResults = await modules.prGenerator.generate(allRecs, ctx);
      const findingByRec = new Map(
        allRecs.map((rec) => [rec.id, rec.finding.id] as const),
      );

      for (const result of prResults) {
        const notes = result.dryRun
          ? 'PR draft generated (dry-run)'
          : result.opened
            ? 'PR opened'
            : `PR not opened: ${result.error ?? 'unknown error'}`;
        const handled = new Set<string>();
        for (const recId of result.draft.sourceRecommendationIds) {
          const findingId = findingByRec.get(recId);
          if (findingId === undefined || handled.has(findingId)) continue;
          handled.add(findingId);

          await stateStore.markState(findingId, 'proposed', notes);

          // Persist PR linkage (markState does not carry pr fields).
          const current = await stateStore.get(findingId);
          if (current !== undefined) {
            await stateStore.record([
              {
                ...current,
                prDraftId: result.draft.id,
                ...(result.url ? { prUrl: result.url } : {}),
                lastSeenAt: ctx.now().toISOString(),
              },
            ]);
          }
        }
      }

      const report: RunReport = {
        runId: ctx.runId,
        startedAt,
        finishedAt: ctx.now().toISOString(),
        dryRun: ctx.dryRun,
        stats,
        prResults,
      };

      logger.info('run complete', {
        runId: report.runId,
        dryRun: report.dryRun,
        domains: Object.keys(stats),
        recommendations: allRecs.length,
        prs: prResults.length,
      });

      return report;
    },
  };
}
