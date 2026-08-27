# GitHub Actions Workflows

## ci-cd.yml — CI quality gate

Runs on relevant pushes and pull requests to `main`, `master` and `develop`. It is also reusable by `release.yml` for manually pushed version tags.

The unit and integration matrices run on Node.js 18, 20, 22, 24 and 26. Stress tests and benchmarks run on Node.js 24. A successful push to `master` or `main` creates the package version tag when it does not exist and dispatches the release workflow on that tag.

Before building, CI runs `npm pkg fix` against a temporary comparison. Any package metadata that npm would normalize fails the build and must be committed explicitly.

## release.yml — npm trusted publication

Runs for version tags, published GitHub releases and manual dispatches. Manual dispatch defaults to a dry run. A real publication must run from a `v*.*.*` tag matching `package.json`.

The release validates semver, the changelog entry, npm metadata, version availability, compiled exports and tarball contents. Publication uses npm trusted publishing with GitHub OIDC and provenance. Any npm failure fails the workflow; there is no token or permission-error fallback.

Configure the npm package trusted publisher with these exact values:

| Setting | Value |
|---------|-------|
| Organization or user | `resilientmq` |
| Repository | `core` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

No `NPM_TOKEN` or `GH_PAT` repository secret is required. The GitHub repository must contain an environment named `npm`, and the npm trusted publisher must use the same environment value.

To rerun a failed release after its tag already exists:

```bash
gh workflow run release.yml --ref v3.0.0 -f dry_run=false
```

## Artifacts

| Artifact | Produced by | Retention |
|----------|-------------|-----------|
| `coverage-report` | `unit-tests` (Node 20) | 30 days |
| `unit-results-nodeXX` | `unit-tests` | 14 days |
| `integration-results-nodeXX` | `integration-tests` | 14 days |
| `stress-results` | `stress-tests` | 30 days |
| `benchmark-results` | `benchmarks` | 90 days |
| `build-artifacts` | `build` | 7 days |
| `release-dist` | `release.yml` validation | 7 days |
