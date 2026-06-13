# Ambient Infra Cleanup Agent

A background agent that quietly handles operational cleanup work that normally never gets prioritized. It runs across **Snowflake**, **dbt**, and **Kubernetes**, finds waste, checks that changes are safe, and opens **reviewable pull requests** — never mutating live systems directly.

---

## What

This is a **recommend-only** infra hygiene agent. On each scheduled run it:

1. **dbt / Snowflake cleanup** — finds dbt models with low or stale usage, checks lineage and downstream dependencies, and drafts PRs to deprecate or flag models for human review.
2. **Kubernetes right-sizing** — watches workload memory utilization, identifies overprovisioned containers, and drafts PRs to lower memory requests conservatively.

Every recommendation ships with evidence (usage, lineage, utilization), a confidence score, estimated savings, risk notes, and rollback instructions. In the MVP, the agent **analyzes read-only** and **outputs PR drafts**; it does not delete models, resize pods, or push changes without going through your normal review flow.

### What it produces

| Domain | Detects | Safety checks | PR action |
| --- | --- | --- | --- |
| dbt | Stale models (no reads), low-read models, orphan models without downstream | Downstream deps, exposures, metrics, recent Snowflake reads | Add deprecation metadata / flag for review |
| Kubernetes | Memory requests far above p95 usage | Recent OOMs, restart storms, insufficient samples, savings below threshold | Edit manifest `resources.requests.memory` |

Example dry-run output:

```
Run run:abc123 — DRY-RUN (report only)
  [dbt] detected=3 safe=2 recommended=3 skipped=0
  [kubernetes] detected=3 safe=2 recommended=2 skipped=1
  Pull requests: 2
    - Deprecate 2 stale dbt models [dry-run]
    - Right-size memory for 2 Kubernetes workloads [dry-run]
```

---

## Why

Data and platform teams accumulate invisible waste:

- **dbt models** keep materializing after dashboards and pipelines stop using them. Snowflake storage and compute costs grow; the DAG gets harder to reason about.
- **Kubernetes workloads** are sized once at deploy time and rarely revisited. Memory requests stay high "just in case," tying up cluster capacity and inflating cloud bills.

These tasks are important but never urgent. They need usage data, lineage context, safety analysis, and a PR someone can review — work that sits in backlogs while cost compounds.

This agent automates the **detect → verify → propose** loop so cleanup happens continuously in the background instead of in a quarterly fire drill.

### Design principles

- **Recommend-only by default** — `dryRun: true` and mock connectors out of the box. Nothing touches production until you opt in.
- **Conservative safety** — downstream dependencies, exposures, OOM history, and restart counts block or downgrade recommendations.
- **Explainable** — every PR body includes usage evidence, lineage/utilization summary, impact estimate, and rollback steps.
- **Auditable** — findings are tracked in a local state store with lifecycle (`detected` → `proposed` → `accepted` / `rejected` / `merged`).

---

## How

### Architecture

The agent is a pipeline of loosely coupled stages. Each domain (dbt, Kubernetes) implements the same three interfaces; orchestration wires them together and opens PRs.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐     ┌──────────────┐
│  Detectors  │ ──▶ │ Safety Analyzers │ ──▶ │ Recommenders│ ──▶ │ PR Generator │
│  (per domain)│     │  (per domain)    │     │ (per domain)│     │  (shared)    │
└─────────────┘     └──────────────────┘     └─────────────┘     └──────────────┘
        │                      │                      │                     │
        └──────────────────────┴──────────────────────┴─────────────────────┘
                                         │
                                  ┌──────▼──────┐
                                  │ State Store │  dedup + lifecycle
                                  └─────────────┘
```

| Component | Path | Role |
| --- | --- | --- |
| Contracts | `src/contracts/` | Locked TypeScript interfaces (`Detector`, `SafetyAnalyzer`, `Recommender`, `PrGenerator`, `StateStore`, `AgentConfig`) |
| dbt module | `src/dbt/` | Reads dbt artifacts + Snowflake usage; flags stale models; produces `dbt-deprecate` recommendations |
| k8s module | `src/k8s/` | Reads utilization metrics + manifests; flags overprovisioned memory; produces `k8s-memory-resize` recommendations |
| Orchestration | `src/orchestration/` | Config loader, JSON state store, GitHub PR generator, runner, reporter |
| CLI | `src/cli.ts` | Entry point: `infra-cleanup` |

See [`CONTRACTS.md`](CONTRACTS.md) for the full locked interface surface and [`prd.md`](prd.md) for product requirements.

### dbt cleanup loop (detail)

**Inputs**

- dbt artifacts: `manifest.json`, `catalog.json`, `run_results.json` (from CI or `dbt docs generate` / `dbt run`)
- Snowflake usage: query/read history keyed by model (mock JSON or live connector — live not implemented in MVP)

**Detection signals**

- No observed reads for `dbt.staleDays` (default 90)
- Fewer than `dbt.lowReadCountPerDays` reads over `dbt.lowReadWindowDays` (default 5 reads / 30 days)
- Models with no downstream dependents or exposures when `flagWithoutDownstream` is true
- Models in `excludedDbtModels` are always skipped

**Safety analysis**

- Direct and transitive downstream dbt dependencies
- Exposures, metrics, and tests referencing the model
- Recent Snowflake reads
- Conservative default: active downstream or exposure → not auto-safe; recommendation mode becomes `flag-for-review` instead of `deprecate`

**PR content**

- Surgical edit to model SQL or `schema.yml` (deprecation tag, `deprecated: true` meta, or doc warning)
- Markdown body: usage summary, lineage, estimated monthly USD savings, risk, rollback

### Kubernetes right-sizing loop (detail)

**Inputs**

- Utilization metrics per workload/container (mock JSON or Prometheus — live not implemented in MVP)
- Kubernetes manifests under `connectors.k8s.manifestsDir`

**Detection**

- Compute p95 (configurable percentile) of historical memory usage samples
- Proposed request = `max(minMemoryMiB, p95 × (1 + bufferPct))` (default: p95 + 30% buffer, floor 64 MiB)
- Flag when savings ≥ `minSavingsFraction` (default 15%) of current request
- Skip namespaces in `excludedNamespaces` (default includes `kube-system`)

**Safety analysis**

- Block if OOM kill within `recentOomDays` (default 7)
- Block if restarts exceed `maxRestarts` (default 5) over the lookback window
- Block if sample count is too low for a reliable percentile
- Requests-only resizing in MVP (limits unchanged unless clearly safe)

**PR content**

- Modified manifest YAML with lower `resources.requests.memory`
- Markdown body: current vs proposed request, MiB saved, utilization evidence, rollback to restore prior value

### PR generation and governance

- Recommendations below `pr.minConfidenceToOpen` (default 0.8) are filtered out
- PRs are batched by domain, capped at `pr.maxPrsPerRun` (default 5)
- Branches prefixed with `pr.branchPrefix` (default `infra-cleanup/`)
- Labels applied: `ai-infra-cleanup`, `automated` (configurable)
- When `pr.dryRun` is true or `connectors.github.mode` is `mock`, PRs are drafted locally only — no network calls, no token required

---

## Quick start

**Requirements:** Node.js ≥ 24, npm ≥ 11

```bash
npm install
npm run build
npm start          # dry-run against bundled fixtures
```

Development (no build step):

```bash
npm run dev
```

Run tests:

```bash
npm test           # 37 tests: smoke + dbt + k8s + orchestration
npm run typecheck
```

### CLI

```
infra-cleanup [--config <path>] [--dry-run] [--once]
```

| Flag | Effect |
| --- | --- |
| `--config <path>` | Load config from JSON file (merged with defaults). Default: `./agent.config.json` if it exists, else built-in `defaultConfig`. |
| `--dry-run` | Force report-only mode even if config sets `pr.dryRun: false`. |
| `--once` | Single scan (default behavior). |

### Configuration

Create `agent.config.json` in the project root to override defaults. Only specify keys you want to change — everything else falls back to [`defaultConfig`](src/contracts/config.ts).

```json
{
  "dbt": {
    "staleDays": 90,
    "lowReadCountPerDays": 5,
    "lowReadWindowDays": 30
  },
  "k8s": {
    "percentile": 95,
    "bufferPct": 30,
    "minSavingsFraction": 0.15
  },
  "excludedDbtModels": ["model.shop.experimental_temp"],
  "excludedNamespaces": ["kube-system", "dev"],
  "pr": {
    "dryRun": true,
    "maxPrsPerRun": 5,
    "minConfidenceToOpen": 0.8,
    "branchPrefix": "infra-cleanup",
    "labels": ["ai-infra-cleanup", "automated"]
  },
  "connectors": {
    "dbt": {
      "mode": "mock",
      "artifactDir": "fixtures/dbt",
      "snowflake": {
        "mode": "mock",
        "mockPath": "fixtures/dbt/snowflake_usage.json"
      }
    },
    "k8s": {
      "metrics": {
        "mode": "mock",
        "mockPath": "fixtures/k8s/metrics.json"
      },
      "manifestsDir": "fixtures/k8s/manifests"
    },
    "github": {
      "mode": "mock",
      "repo": "your-org/your-repo",
      "baseBranch": "main",
      "tokenEnv": "GITHUB_TOKEN"
    }
  },
  "enabledDomains": ["dbt", "kubernetes"],
  "logLevel": "info"
}
```

**Going live (not implemented in MVP):** set connector `mode` to `live`, provide credentials via the env var named in `credentialsEnv` / `tokenEnv`, and set `pr.dryRun: false`. Live Snowflake, Prometheus, and GitHub paths throw clear errors today — mock mode is the verified path.

### Fixtures (mock mode)

Bundled sample data under [`fixtures/`](fixtures/) lets you run end-to-end without real infrastructure. See [`fixtures/README.md`](fixtures/README.md) for layout and scenario coverage.

### State store

Finding lifecycle is persisted to `.agent-state/findings.json` (configurable via `createStateStore(stateDir)`). This deduplicates repeated detections across runs and tracks whether a finding has been proposed, accepted, or rejected.

---

## Project layout

```
src/
  contracts/       # Locked interfaces and defaultConfig
  core/            # Logger, confidence scoring, stable IDs
  dbt/             # dbt detector, analyzer, recommender, connectors
  k8s/             # k8s detector, analyzer, recommender, connectors
  orchestration/   # Config, state, PR generator, runner
  cli.ts           # CLI entry point
fixtures/          # Mock dbt artifacts, Snowflake usage, k8s metrics + manifests
test/              # Cross-module smoke tests
CONTRACTS.md       # Locked contract reference for contributors
prd.md             # Product requirements document
```

---

## MVP scope and limitations

**Included**

- Mock connectors for dbt artifacts, Snowflake usage, k8s metrics, and manifests
- Dry-run PR drafting with full evidence bodies
- Configurable thresholds, exclusions, confidence gates, and PR rate limits
- JSON state store for dedup and lifecycle tracking

**Not included (yet)**

- Live Snowflake query history connector
- Live Prometheus / metrics-server connector
- Live GitHub PR creation (guarded code exists but is unreachable in tests)
- CPU right-sizing, HPA tuning, or direct resource deletion
- Slack notifications, BI tool integrations, or auto-merge

---

## Contributing

1. Read [`CONTRACTS.md`](CONTRACTS.md) — interfaces under `src/contracts/` and `src/core/` are locked; propose changes to the Lead before editing.
2. Each domain module owns its folder (`src/dbt/`, `src/k8s/`, `src/orchestration/`).
3. Use `ctx.now()` for time, `stableId()` for finding IDs, and the `Logger` interface — no raw `console.log` in domain code.
4. Add tests alongside your module (`src/<domain>/*.test.ts`); keep `test/smoke.test.ts` green.
