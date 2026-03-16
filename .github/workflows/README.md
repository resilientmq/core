# GitHub Actions Workflows

## ci.yml — Continuous Integration

Runs on every push/PR to `main`, `master`, `develop`.

| Job | Description | Node versions |
|-----|-------------|---------------|
| `unit-tests` | Unit tests + coverage (≥70% lines) | 18, 20, 22, 24 |
| `integration-tests` | Integration tests against RabbitMQ | 18, 20, 22, 24 |
| `build` | TypeScript compilation + dist verification | 20 |
| `summary` | Coverage table in GitHub Step Summary | 20 |

Coverage report is uploaded as artifact `coverage-report` from Node 20 run.

## stress-benchmarks.yml — Stress & Benchmarks

Runs on push to `main`/`master` (src or test changes) and on manual dispatch.

| Job | Description | Threshold |
|-----|-------------|-----------|
| `stress-tests` | High-volume tests | Error rate < 1% |
| `benchmarks` | Performance benchmarks | ≥100 msg/s, ≤1000ms latency |

## publish.yml — NPM Publish

Runs on push to `master` when `src/` or `package.json` changes.

- Skips if version already exists on npm
- Creates a git tag `vX.Y.Z`
- Publishes to npm (requires `NPM_TOKEN` secret)

## Required Secrets

| Secret | Used by |
|--------|---------|
| `NPM_TOKEN` | `publish.yml` |
