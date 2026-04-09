const { spawnSync } = require('node:child_process');
const path = require('node:path');

function hasDockerRuntime() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

function runJestIntegration() {
  const jestArgs = [
    'jest',
    '--config',
    path.join('test', 'jest.config.integration.js'),
    '--forceExit'
  ];

  const result = spawnSync('npx', jestArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    console.error('[Integration] Failed to execute Jest:', result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (!hasDockerRuntime()) {
  console.warn('[Integration] Skipped: no Docker/Testcontainers runtime available on this machine.');
  process.exit(0);
}

runJestIntegration();
