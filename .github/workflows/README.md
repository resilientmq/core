# GitHub Workflows

This directory contains GitHub Actions workflows for automated CI/CD.

## Workflow: CI/CD Pipeline (`ci-cd.yml`)

Unified pipeline that handles testing, building, and publishing to npm.

### Jobs and Dependencies

```
unit-tests (Node 18, 20, 22, 24)
    ↓
integration-tests (Node 18, 20, 22, 24)
    ↓
    ├─→ stress-tests
    └─→ benchmarks
         ↓
       build (only if all tests pass)
         ↓
      publish (only on master, if everything passes)
         ↓
    test-summary (always runs, with complete details)
```

### Triggers

The workflow only runs when changes are made to:
- `src/**` - Source code
- `test/**` - Test files
- `package.json` - Dependencies
- `package-lock.json` - Lock file
- `tsconfig.json` - TypeScript config
- `.github/workflows/**` - Workflow files

**Branches:**
- **Push** to: `main`, `master`, `develop`
- **Pull Request** to: `main`, `master`, `develop`

### Jobs

#### 1. Unit Tests
- Runs on Node.js 18, 20, 22, and 24
- Executes unit tests with coverage
- Verifies coverage is >= 70%
- Uploads coverage reports and results

#### 2. Integration Tests
- Runs on Node.js 18, 20, 22, and 24
- Starts RabbitMQ as a service
- Waits up to 60 seconds for RabbitMQ to be ready
- Executes integration tests
- Uploads test results

#### 3. Stress Tests
- Only runs if unit-tests and integration-tests pass
- Starts RabbitMQ as a service
- Executes system stress tests
- Validates quality metrics:
  - Error rate must be < 1%
  - Throughput must meet minimums
- Uploads stress test results

#### 4. Benchmarks
- Only runs if unit-tests and integration-tests pass
- Starts RabbitMQ as a service
- Executes performance benchmarks
- Validates performance thresholds:
  - Minimum throughput: 100 msg/s
  - Maximum average latency: 1000 ms
- Compares with previous benchmarks
- Uploads benchmark results
- **Note:** Continues even if some benchmarks fail

#### 5. Build
- Only runs if all tests pass (unit, integration, stress, benchmarks)
- Compiles TypeScript project
- Verifies package structure
- Uploads build artifacts

#### 6. Publish to NPM
- **Only runs on `master` branch**
- **Only if all tests and build pass**
- Downloads build artifacts
- Checks for changes in `src/` folder
- Checks if version already exists on npm
- Creates git tag if necessary
- Publishes to npm if:
  - ✅ There are changes in `src/`
  - ✅ Version doesn't exist on npm
  - ✅ All tests passed

#### 7. Test Summary
- Always runs (even if there are failures)
- Downloads all generated artifacts
- Generates detailed summary with:
  - **Workflow information**: Branch, commit, trigger
  - **Status of each job**: Unit, Integration, Stress, Benchmarks, Build
  - **Stress test metrics**: Throughput, error rate, messages processed
  - **Benchmark results**: Throughput, average latency
  - **Coverage report**: Table with lines, branches, functions, statements
  - **Final result**: Summary of failed jobs and overall status
  - **Artifacts list**: Available for download
- Fails if any required job failed
- Shows "Ready for publish" message if on master and everything passed

### Required Environment Variables

#### Secrets
- `NPM_TOKEN`: npm token for publishing (only for publish job)
- `GITHUB_TOKEN`: Automatically provided by GitHub Actions

### RabbitMQ Configuration

Integration tests use RabbitMQ as a service with:
- AMQP Port: 5672
- Management Port: 15672
- Health checks every 10s
- Timeout of 10s
- 10 retries
- Start period of 60s

### Generated Artifacts

- **coverage-report**: Coverage reports (30 days)
- **unit-test-results**: Unit test results (30 days)
- **integration-test-results**: Integration test results (30 days)
- **stress-test-results**: Stress test results (30 days)
- **benchmark-results**: Benchmark results (90 days)
- **build-artifacts**: Compiled files (7 days)

### Notes

- Unit tests don't require RabbitMQ
- Integration tests wait up to 60 seconds for RabbitMQ
- Publishing only happens on `master` after all tests pass
- If there are no changes in `src/`, it won't publish even if the version is new
- Workflow is skipped entirely if changes are only in documentation or other non-code files
- Benchmarks are allowed to fail without blocking the pipeline (warnings only)
