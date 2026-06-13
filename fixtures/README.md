# Fixtures

Sample data for **mock-mode** connectors. Lets you run the full agent pipeline (`npm start`) without Snowflake, Prometheus, or a live cluster.

Paths below match [`defaultConfig`](../src/contracts/config.ts). Override via `agent.config.json` → `connectors`.

## Layout

| Path | Used by | Contents |
| --- | --- | --- |
| `dbt/manifest.json` | dbt connector | Model nodes, `child_map`, exposures, dependencies |
| `dbt/catalog.json` | dbt connector | Column metadata |
| `dbt/run_results.json` | dbt connector | Last materialization times |
| `dbt/snowflake_usage.json` | Snowflake usage connector | Per-model read counts, `lastReadAt`, `monthlyComputeUsd` |
| `k8s/metrics.json` | k8s metrics connector | Workload utilization samples, OOM/restart history, `manifestPath` |
| `k8s/manifests/*.yaml` | k8s manifest connector | Deployment YAML the PR generator would edit |

## Scenario coverage

### dbt (`fixtures/dbt/`)

| Model | Scenario | Expected agent behavior |
| --- | --- | --- |
| `model.shop.stale_orders_snapshot` | No reads >90d, no downstream | **Deprecate** |
| `model.shop.legacy_revenue` | Stale but has downstream models + exposure | **Flag for review** (blocker) |
| `model.shop.daily_active_users` | Actively read recently | **No finding** |
| `model.shop.experimental_temp` | Stale but in `excludedDbtModels` | **No finding** (when excluded in config) |

### Kubernetes (`fixtures/k8s/`)

| Workload | Scenario | Expected agent behavior |
| --- | --- | --- |
| `deployment/prod/api` | Request 1Gi, p95 ~530MiB | **Resize** → ~690Mi |
| `deployment/prod/worker` | Overprovisioned but recent OOM + high restarts | **Blocked** by safety analyzer |
| `deployment/dev/scratch` | In excluded namespace `dev` | **No finding** |
| `deployment/prod/cache` | Savings below 15% threshold | **No finding** |
| `deployment/prod/tiny` | Too few usage samples | **Skipped** (insufficient data) |

## Snowflake usage JSON shape

Keyed by dbt `unique_id` or relation name:

```json
{
  "model.shop.stale_orders_snapshot": {
    "readCount": 0,
    "windowDays": 30,
    "lastReadAt": null,
    "monthlyComputeUsd": 42.50
  }
}
```

## k8s metrics JSON shape

Array of workload records:

```json
[
  {
    "workload": "deployment/prod/api",
    "namespace": "prod",
    "container": "api",
    "requestMemory": "1Gi",
    "limitMemory": "1Gi",
    "usageSamplesMiB": [520, 540, 530, 510, 550],
    "oomKills": 0,
    "restarts": 0,
    "manifestPath": "api.yaml"
  }
]
```

See the [main README](../README.md) for how these feed the detect → assess → recommend → PR pipeline.
