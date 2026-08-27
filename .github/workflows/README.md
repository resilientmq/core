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
| `unit-tests` | Unit tests + coverage | 18, 20, 22, 24, 26 |
| `integration-tests` | Integration tests against RabbitMQ | 18, 20, 22, 24, 26 |
| `stress-tests` | High-volume tests (error rate < 1%) | 24 |
| `benchmarks` | Performance benchmarks (≥100 msg/s, ≤1000ms latency) | 24 |
| `build` | TypeScript compilation + dist verification | 24 |
| `publish` | Publish to npm with OIDC + create git tag | 24 |
| `summary` | Coverage table + pipeline status in GitHub Step Summary | 24 |

### Publish conditions

`publish` runs only on push to `main`/`master` and skips if the version in `package.json` is already on npm.

### npm Trusted Publisher

The workflow does not use long-lived npm or GitHub PAT secrets. Configure the package on npm with these Trusted Publisher values before merging a new version:

| Setting | Value |
|---------|-------|
| Provider | GitHub Actions |
| Organization or user | `resilientmq` |
| Repository | `core` |
| Workflow filename | `ci-cd.yml` |
| Environment | None |
| Allowed action | `npm publish` |

The publish job requests `id-token: write`, uses npm 12.0.2 to exchange the GitHub OIDC identity, and receives automatic provenance from npm. The scoped `GITHUB_TOKEN` supplied by GitHub creates the release tag through `contents: write`.

### Artifacts

| Artifact | Produced by | Retention |
|----------|-------------|-----------|
| `coverage-report` | `unit-tests` (Node 20) | 30 days |
| `unit-results-nodeXX` | `unit-tests` | 14 days |
| `integration-results-nodeXX` | `integration-tests` | 14 days |
| `stress-results` | `stress-tests` | 30 days |
| `benchmark-results` | `benchmarks` | 90 days |
| `build-artifacts` | `build` | 7 days |
