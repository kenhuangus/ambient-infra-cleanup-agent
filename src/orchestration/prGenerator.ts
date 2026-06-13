/**
 * GitHub PR generator (Wave 2c).
 *
 * Turns safe recommendations into review-ready `PullRequestDraft`s with a
 * thorough markdown body (candidate, usage/utilization, lineage/safety
 * evidence, estimated impact, risk assessment, reviewer/owner note, and
 * rollback) and honors `dryRun` / mock mode by never touching the network.
 *
 * Read-only contract: the agent never mutates source systems. The only
 * side effect in `live` + non-dry-run mode is opening a PR via the Git host.
 */

import type {
  AgentConfig,
  FileChange,
  Finding,
  ImpactEstimate,
  PrGenerationResult,
  PrGenerator,
  PullRequestDraft,
  Recommendation,
  RunContext,
} from '../contracts/index.js';
import { shortHash, slug, stableId } from '../core/index.js';

type DomainKey = Finding['domain'];

/** Create the GitHub PR generator (honors `config.pr.dryRun` + mock mode). */
export function createGithubPrGenerator(): PrGenerator {
  return {
    async generate(
      recommendations: Recommendation[],
      ctx: RunContext,
    ): Promise<PrGenerationResult[]> {
      const { config, logger } = ctx;

      // 1. Confidence gate.
      const eligible = recommendations.filter(
        (rec) => rec.assessment.confidence.score >= config.pr.minConfidenceToOpen,
      );

      // 2. Batch by domain (one PR per domain, combining recs sensibly).
      const groups = new Map<DomainKey, Recommendation[]>();
      for (const rec of eligible) {
        const list = groups.get(rec.finding.domain) ?? [];
        list.push(rec);
        groups.set(rec.finding.domain, list);
      }

      let drafts: PullRequestDraft[] = [...groups.entries()].map(
        ([domain, recs]) => buildDraft(domain, recs, config),
      );

      // 3. Respect the per-run PR cap (anti-spam / batching).
      if (drafts.length > config.pr.maxPrsPerRun) {
        drafts = capDrafts(drafts, config.pr.maxPrsPerRun, config);
      }

      // 4. Open or report each draft.
      const isMock = config.connectors.github.mode === 'mock';
      const dryRun = ctx.dryRun || isMock;

      const results: PrGenerationResult[] = [];
      for (const draft of drafts) {
        if (dryRun) {
          logger.info('pr draft prepared (dry-run)', {
            title: draft.title,
            branch: draft.branch,
            recs: draft.sourceRecommendationIds.length,
          });
          results.push({ draft, dryRun: true, opened: false });
          continue;
        }
        results.push(await openPullRequest(draft, config, logger));
      }
      return results;
    },
  };
}

/** Build a single PR draft for a domain's recommendations. */
function buildDraft(
  domain: DomainKey,
  recs: Recommendation[],
  config: AgentConfig,
): PullRequestDraft {
  const recIds = recs.map((rec) => rec.id);
  const title = draftTitle(domain, recs);
  return {
    id: stableId('pr', domain, ...recIds),
    title,
    body: buildBody(domain, title, recs),
    branch: `${config.pr.branchPrefix}/${slug(domain)}-${shortHash(...recIds)}`,
    labels: config.pr.labels,
    changes: unionChanges(recs),
    sourceRecommendationIds: recIds,
  };
}

/** Merge overflow drafts so the result never exceeds `max` PRs. */
function capDrafts(
  drafts: PullRequestDraft[],
  max: number,
  config: AgentConfig,
): PullRequestDraft[] {
  if (max <= 0) return [];
  if (drafts.length <= max) return drafts;
  const kept = drafts.slice(0, max - 1);
  const overflow = drafts.slice(max - 1);
  return [...kept, mergeDrafts(overflow, config)];
}

/** Combine several drafts into one (used only when over the PR cap). */
function mergeDrafts(
  drafts: PullRequestDraft[],
  config: AgentConfig,
): PullRequestDraft {
  const ids = drafts.flatMap((draft) => draft.sourceRecommendationIds);
  const seen = new Set<string>();
  const changes: FileChange[] = [];
  for (const draft of drafts) {
    for (const change of draft.changes) {
      const key = `${change.path}|${change.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(change);
    }
  }
  return {
    id: stableId('pr', 'combined', ...ids),
    title: `Infra cleanup: ${ids.length} recommendation(s) across ${drafts.length} groups`,
    body: drafts.map((draft) => draft.body).join('\n\n---\n\n'),
    branch: `${config.pr.branchPrefix}/combined-${shortHash(...ids)}`,
    labels: config.pr.labels,
    changes,
    sourceRecommendationIds: ids,
  };
}

function draftTitle(domain: DomainKey, recs: Recommendation[]): string {
  const n = recs.length;
  const first = recs[0];
  if (domain === 'dbt') {
    return n === 1 && first
      ? `Deprecate stale dbt model \`${first.finding.targetRef}\``
      : `Deprecate ${n} stale dbt models`;
  }
  return n === 1 && first
    ? `Right-size memory for ${first.finding.targetRef}`
    : `Right-size memory for ${n} Kubernetes workloads`;
}

function unionChanges(recs: Recommendation[]): FileChange[] {
  const seen = new Set<string>();
  const out: FileChange[] = [];
  for (const rec of recs) {
    for (const change of rec.action.changes) {
      const key = `${change.path}|${change.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(change);
    }
  }
  return out;
}

/** Render the full markdown body satisfying the PRD's "Each PR must include". */
function buildBody(
  domain: DomainKey,
  title: string,
  recs: Recommendation[],
): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    '> Generated by the Ambient Infra Cleanup Agent (recommend-only). ' +
      'Review before merging.',
    '',
    `Batched ${recs.length} recommendation(s) in the **${domain}** domain.`,
    '',
  ];
  recs.forEach((rec, idx) => {
    lines.push(renderRecommendation(rec, idx + 1));
    lines.push('');
  });
  return lines.join('\n');
}

function renderRecommendation(rec: Recommendation, index: number): string {
  const finding = rec.finding;
  const assessment = rec.assessment;
  const lines: string[] = [];

  lines.push(`## ${index}. ${finding.title}`);
  lines.push('');
  lines.push(
    `- **Candidate:** \`${finding.targetRef}\` (${rec.action.type}, ${finding.domain})`,
  );
  if (rec.action.type === 'dbt-deprecate') {
    lines.push(
      `- **Action:** dbt ${rec.action.mode} for model \`${rec.action.model}\``,
    );
  } else {
    const limit =
      rec.action.currentLimit !== undefined && rec.action.proposedLimit !== undefined
        ? `, limit ${rec.action.currentLimit} → ${rec.action.proposedLimit}`
        : '';
    lines.push(
      `- **Action:** resize ${rec.action.workload}/${rec.action.container} ` +
        `request ${rec.action.currentRequest} → ${rec.action.proposedRequest}${limit}`,
    );
  }

  lines.push('');
  lines.push('### Usage / utilization summary');
  if (finding.signals.length === 0) {
    lines.push('- _No signals recorded._');
  } else {
    for (const signal of finding.signals) lines.push(`- ${signal.summary}`);
  }

  lines.push('');
  lines.push('### Lineage / dependency / safety evidence');
  if (assessment.reasons.length === 0) {
    lines.push('- _No safety reasons recorded._');
  } else {
    for (const reason of assessment.reasons) lines.push(`- ${reason.summary}`);
  }
  if (assessment.blockers.length > 0) {
    lines.push('');
    lines.push('### Blockers (flag-for-review only)');
    for (const blocker of assessment.blockers) lines.push(`- ${blocker}`);
  }

  lines.push('');
  lines.push('### Estimated impact');
  lines.push(`- ${formatImpact(rec.estimatedImpact)}`);

  lines.push('');
  lines.push('### Risk assessment');
  lines.push(`- Safe to act automatically: ${assessment.safe ? 'yes' : 'no (review)'}`);
  lines.push(
    `- Confidence: ${assessment.confidence.level} ` +
      `(${assessment.confidence.score.toFixed(2)})` +
      (assessment.confidence.rationale
        ? ` — ${assessment.confidence.rationale}`
        : ''),
  );

  lines.push('');
  lines.push('### Reviewer / owner');
  lines.push(`- ${ownerNote(finding)}`);

  lines.push('');
  lines.push('### Rollback');
  lines.push(`- ${rec.rollback}`);

  lines.push('');
  lines.push('### Proposed changes');
  if (rec.action.changes.length === 0) {
    lines.push('- _No file changes._');
  } else {
    for (const change of rec.action.changes) {
      lines.push(`- \`${change.path}\` (${change.kind}): ${change.description}`);
    }
  }

  return lines.join('\n');
}

function formatImpact(impact?: ImpactEstimate): string {
  if (impact === undefined) return 'Estimated impact: not quantified.';
  if (impact.estimatedValue === undefined) return impact.description;
  const unit = impact.unit ? ` ${impact.unit}` : '';
  return `${impact.description} (~${impact.estimatedValue}${unit})`;
}

function ownerNote(finding: Finding): string {
  for (const signal of finding.signals) {
    const owner = signal.data?.['owner'];
    if (typeof owner === 'string' && owner.length > 0) {
      return `Suggested reviewer: ${owner} (from ${signal.kind}).`;
    }
  }
  return 'Assign to the model/workload owner (see CODEOWNERS / dbt meta / namespace labels).';
}

/**
 * Minimal live PR-open path. GUARDED: only reachable when NOT dry-run AND the
 * GitHub connector is `live`. The token is read from `config…tokenEnv` and is
 * never logged or embedded in the draft. Unreachable in tests (which use
 * dry-run / mock mode).
 */
async function openPullRequest(
  draft: PullRequestDraft,
  config: AgentConfig,
  logger: RunContext['logger'],
): Promise<PrGenerationResult> {
  const tokenEnv = config.connectors.github.tokenEnv;
  const token = process.env[tokenEnv];
  if (token === undefined || token === '') {
    logger.warn('skipping live PR: token env not set', { tokenEnv });
    return {
      draft,
      dryRun: false,
      opened: false,
      error: `GitHub token env ${tokenEnv} is not set`,
    };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.connectors.github.repo}/pulls`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'ambient-infra-cleanup-agent',
        },
        body: JSON.stringify({
          title: draft.title,
          head: draft.branch,
          base: config.connectors.github.baseBranch,
          body: draft.body,
        }),
      },
    );
    if (!response.ok) {
      return {
        draft,
        dryRun: false,
        opened: false,
        error: `GitHub responded ${response.status}`,
      };
    }
    const data = (await response.json()) as { html_url?: string };
    return {
      draft,
      dryRun: false,
      opened: true,
      ...(data.html_url ? { url: data.html_url } : {}),
    };
  } catch (error) {
    return {
      draft,
      dryRun: false,
      opened: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
