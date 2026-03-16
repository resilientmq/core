# GitHub Actions Workflows

## ci-cd.yml — CI/CD Pipeline

Runs on push/PR to `main`, `master`, `develop` (when `src/`, `test/`, `package.json`, `tsconfig.json`, or workflow files change).

### Job order

```
unit-tests ──┐
             ├──► integration-tests ──┬──► stress-tests ──┐
             │                        └──► benchmarks   ──┴──► build ──┬──► publish
             │                                                          └──► summary
```

| Job | Description | Node versions |
|-----|-------------|---------------|
| `unit-tests` | Unit tests + coverage | 18, 20, 22, 24, 25 |
| `integration-tests` | Integration tests against RabbitMQ | 18, 20, 22, 24, 25 |
| `stress-tests` | High-volume tests (error rate < 1%) | 20 |
| `benchmarks` | Performance benchmarks (≥100 msg/s, ≤1000ms latency) | 20 |
| `build` | TypeScript compilation + dist verification | 20 |
| `publish` | Publish to npm + create git tag | 20 |
| `summary` | Coverage table + pipeline status in GitHub Step Summary | 20 |

### Publish conditions

`publish` runs only on push to `main`/`master` and skips if the version in `package.json` is already on npm.

### Required secrets

| Secret | Used by |
|--------|---------|
| `NPM_TOKEN` | `publish` job |

### Artifacts

| Artifact | Produced by | Retention |
|----------|-------------|-----------|
| `coverage-report` | `unit-tests` (Node 20) | 30 days |
| `unit-results-nodeXX` | `unit-tests` | 14 days |
| `integration-results-nodeXX` | `integration-tests` | 14 days |
| `stress-results` | `stress-tests` | 30 days |
| `benchmark-results` | `benchmarks` | 90 days |
| `build-artifacts` | `build` | 7 days |
