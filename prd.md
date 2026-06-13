# PRD: Ambient Infra Cleanup Agent

| Field | Value |
| --- | --- |
| Status | Draft |
| Version | 0.1 |
| Owner | TBD |
| Last updated | 2026-06-13 |
| Reviewers | Data platform, Platform/Infra, FinOps |

## Overview

Build an ambient infrastructure agent that runs quietly in the background across Snowflake, dbt, and Kubernetes. The agent identifies operational cleanup opportunities that usually do not get prioritized, verifies that changes are safe, and opens pull requests for human-reviewed remediation.

The first product surface focuses on two high-cost cleanup loops:

1. Deprecating stale or low-usage dbt models after checking lineage, dependencies, and ownership.
2. Reducing Kubernetes overprovisioning by recommending safer memory allocation changes via pull requests.

In the MVP the agent is recommend-only: it analyzes with read-only access and proposes changes as reviewable pull requests. It never mutates Snowflake, dbt, or Kubernetes resources directly.

## Problem

Data and infrastructure platforms accumulate waste over time. dbt models keep running after usage drops, Snowflake spend grows around stale tables, and Kubernetes workloads are often overprovisioned because nobody has time to tune them continuously.

These tasks are important but rarely urgent. They require context gathering, safety checks, stakeholder coordination, and follow-through. As a result, they sit in backlogs while cost and complexity compound.

## Goals

- Continuously detect stale, low-value, or overprovisioned infrastructure.
- Convert cleanup opportunities into reviewable pull requests, not opaque automated changes.
- Make every recommendation explainable with usage, lineage, dependency, and utilization evidence.
- Reduce warehouse, storage, and Kubernetes spend without breaking production workloads.
- Build trust through conservative defaults, clear safety gates, and auditability.

## Non-Goals

- The agent will not delete dbt models, Snowflake objects, or Kubernetes resources directly in the MVP.
- The agent will not bypass existing CI, code owner, data governance, or platform approval flows.
- The agent will not optimize query logic, rewrite dbt model SQL, or redesign application architecture.
- The agent will not make production Kubernetes changes without a configurable review or rollout policy.

## Target Users

- Data platform engineers responsible for dbt reliability, warehouse spend, and model lifecycle hygiene.
- Analytics engineers who own dbt models but do not have time to manually audit stale assets.
- Infrastructure and platform engineers responsible for Kubernetes efficiency and workload sizing.
- Engineering managers and FinOps teams looking for sustained cost reduction without disruptive cleanup projects.

## System Components

The agent is composed of loosely coupled stages so that detectors, analyzers, and PR generators can evolve independently.

- **Connectors (read-only):** Snowflake query history and account usage, dbt artifacts (`manifest.json`, `catalog.json`, `run_results.json`), Kubernetes metrics (e.g. Prometheus or a metrics backend), and the Git host (GitHub for MVP).
- **Detectors:** Identify candidates per domain (stale dbt models, overprovisioned workloads) against configurable thresholds.
- **Safety analyzers:** Enrich candidates with lineage, dependency, ownership, and stability checks, and assign a confidence score.
- **Recommendation engine:** Converts safe candidates into concrete change proposals (deprecation metadata, memory request edits).
- **PR generator:** Opens batched, labeled pull requests with evidence and rollback instructions, respecting repo policies.
- **State store:** Tracks finding lifecycle (detected, proposed, accepted, rejected, merged, reverted) for dedup and reporting.
- **Scheduler/runner:** Drives periodic scans, respects quiet hours and rate limits, and emits summary reports.

## Core User Stories

- As a data platform engineer, I want the agent to identify dbt models with low or stale usage so that I can safely remove unnecessary compute and storage.
- As an analytics engineer, I want each deprecation PR to include lineage, downstream dependencies, owner information, and usage evidence so that I can review it quickly.
- As a platform engineer, I want the agent to flag Kubernetes workloads with consistently overprovisioned memory so that I can reduce waste without causing OOMs.
- As a reviewer, I want every automated PR to explain why the change is safe, what was checked, and what rollback path exists.
- As a FinOps stakeholder, I want reporting on accepted recommendations, avoided spend, and cleanup backlog so that I can measure impact over time.

## Product Requirements

### 1. dbt Model Usage Detection

The agent must identify candidate dbt models that appear stale, low-value, or underused.

Signals should include:

- Snowflake query history referencing model tables or views.
- dbt artifacts such as `manifest.json`, `catalog.json`, and `run_results.json`.
- Last successful materialization time.
- Downstream dbt model, exposure, metric, and source dependencies.
- BI or semantic layer usage where integrations are available.
- Model ownership from dbt metadata, code owners, tags, or configured mappings.

The agent must support configurable thresholds, including:

- No observed reads for N days.
- Low read frequency over N days.
- High compute cost with low downstream usage.
- Models without exposures or downstream dependencies.

### 2. Lineage and Safety Analysis

Before proposing deprecation, the agent must check whether a model is safe to remove or should only be flagged for review.

Required checks:

- Direct and transitive downstream dbt dependencies.
- Exposures, metrics, tests, snapshots, seeds, and documentation references.
- Recent query history from Snowflake.
- Scheduled jobs, dashboards, notebooks, or external consumers where metadata is available.
- Ownership and approval requirements.

Each recommendation must include a confidence level and evidence summary.

### 3. Deprecation PR Generation

For safe or reviewable candidates, the agent must open a pull request that follows the repository's dbt deprecation pattern.

Possible PR actions:

- Add a deprecation tag or metadata field.
- Add a warning to model documentation.
- Disable a model only when the repository has an established safe-disable workflow.
- Remove downstream references only when generated by a known, reversible pattern.

Each PR must include:

- Candidate model name and path.
- Usage summary.
- Lineage and dependency summary.
- Estimated cost or complexity reduction.
- Risk assessment.
- Reviewer or owner suggestions.
- Rollback instructions.

### 4. Kubernetes Utilization Monitoring

The agent must monitor Kubernetes workloads for memory overprovisioning.

Signals should include:

- Requested memory.
- Actual memory usage over time.
- Peak usage and percentile usage, such as p95 and p99.
- OOM kill history.
- Restart count.
- Deployment, StatefulSet, CronJob, and namespace metadata.
- Existing autoscaling policies and resource limit configuration.

The agent must avoid recommendations when utilization data is insufficient, spiky, or unsafe.

### 5. Memory Right-Sizing Recommendations

The agent must propose memory allocation changes for workloads with sustained overprovisioning.

Recommendation behavior:

- Prefer conservative reductions based on historical p95 or p99 usage plus a safety buffer.
- Respect minimum memory floors by namespace, workload type, or team policy.
- Avoid changes for workloads with recent OOMs, high restart rates, or unstable traffic.
- Support dry-run mode where recommendations are reported but no PR is opened.

The MVP should open PRs against Kubernetes manifests or Helm/Kustomize configuration rather than applying changes directly to the cluster.

### 6. Background Agent Behavior

The agent should run on a schedule and require minimal human coordination.

Required behavior:

- Scan connected systems on a configurable cadence.
- Deduplicate repeated findings.
- Track recommendation state across detection, PR opened, accepted, rejected, merged, and reverted.
- Avoid noisy PR creation by batching related cleanup work.
- Respect quiet hours, rate limits, and repository contribution policies.

### 7. Safety, Auditability, and Governance

The system must be conservative by default.

Required controls:

- Read-only access for Snowflake, dbt metadata, and Kubernetes metrics during analysis.
- Configurable approval gates before PR creation.
- Full audit trail of evidence, generated recommendations, and opened PRs.
- Confidence scoring for every proposed change.
- Repository-specific policy configuration for what the agent may modify.
- Clear labeling for AI-generated operational cleanup PRs.

## MVP Scope

The MVP should support:

- Snowflake usage analysis for dbt model tables and views.
- dbt lineage analysis from local or CI-generated artifacts.
- GitHub PR creation for dbt deprecation metadata updates.
- Kubernetes memory recommendation analysis from metrics data.
- GitHub PR creation for memory request changes in Kubernetes manifests.
- A simple configuration file for thresholds, owners, excluded models, excluded namespaces, and PR behavior.
- A summary report of findings, skipped candidates, and opened PRs.

## Assumptions and Dependencies

- Snowflake query history or account usage views are accessible and retain enough history to judge staleness (for example, at least 90 days).
- dbt artifacts are produced by CI or available locally and are reasonably current.
- A Kubernetes metrics source retains historical utilization long enough to compute p95/p99 over the evaluation window.
- The agent has permission to open pull requests (branch + PR scope) on the target repositories.
- dbt models and Kubernetes config are version-controlled in repositories the agent can reach.
- Model and workload ownership can be derived from metadata, code owners, tags, or a configured mapping.

## Milestones

- **M0 - Foundations:** Connectors, config schema, state store, read-only access verified across all systems.
- **M1 - dbt cleanup loop:** Detection, lineage/safety analysis, and deprecation PR generation against a test repo.
- **M2 - Kubernetes cleanup loop:** Utilization monitoring, memory right-sizing, and PR generation against manifests/Helm/Kustomize.
- **M3 - Background operation:** Scheduling, dedup, batching, quiet hours, and summary reporting.
- **M4 - Hardening:** Confidence tuning, false-positive reduction, audit trail, and reviewer feedback loop.

## Future Scope

- Direct integration with BI tools such as Looker, Mode, Tableau, Hex, or Sigma.
- Slack notifications and owner approval workflows.
- Automated follow-up after deprecation windows expire.
- Cost attribution by team, namespace, model, or workload.
- CPU right-sizing and autoscaling recommendations.
- Automatic rollback detection when merged changes cause incidents or performance regressions.
- Multi-repository support for organizations with split dbt and infrastructure repos.

## Success Metrics

Targets below are initial proposals to be calibrated against a baseline captured in M0.

- Reviewer acceptance rate for generated PRs (target: >= 60% within first 90 days).
- False positive rate for unsafe or irrelevant recommendations (target: <= 10%).
- Incidents or rollbacks caused by accepted recommendations (target: 0).
- Percentage reduction in Kubernetes memory overprovisioning across in-scope workloads (target: >= 20%).
- Percentage reduction in Snowflake spend attributable to deprecated or disabled stale models (target: directional, baseline-dependent).
- Number of accepted cleanup PRs per month (target: trending up, no upper cap).
- Median time from finding detection to merged cleanup (target: < 14 days).

## Key Risks

- A model may appear unused while still serving an undocumented external consumer.
- Kubernetes utilization history may not reflect future traffic spikes.
- Too many low-value PRs may create reviewer fatigue.
- Repository-specific dbt and Kubernetes conventions may vary widely.
- Cost savings may be difficult to attribute without good billing metadata.

## Open Questions

- Which systems are required for MVP integrations: GitHub, GitLab, Snowflake, dbt Cloud, local dbt artifacts, Prometheus, or a managed Kubernetes metrics backend?
- Should the agent only open PRs, or should it support automatic merge for low-risk changes after approval?
- What is the default deprecation window for stale dbt models?
- What confidence threshold is required before opening a PR?
- How should owners configure exclusions for critical models and workloads?
- Should Kubernetes recommendations modify requests only, limits only, or both?

## Launch Criteria

- The agent can identify stale dbt model candidates with clear usage and lineage evidence.
- The agent can open safe, reviewable deprecation PRs in a test dbt repository.
- The agent can identify overprovisioned Kubernetes workloads using historical utilization data.
- The agent can open safe, reviewable memory right-sizing PRs against Kubernetes configuration.
- All generated PRs include evidence, risk assessment, and rollback instructions.
- The agent runs repeatedly without duplicating stale findings or spamming reviewers.
