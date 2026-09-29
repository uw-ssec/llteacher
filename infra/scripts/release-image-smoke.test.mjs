import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const image = process.env.LLTEACHER_RELEASE_TEST_IMAGE;
test('workflow smoke block accepts the actual production runtime image', { skip: !image }, () => {
  const workflow = require('js-yaml').load(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const step = workflow.jobs.test.steps.find(step => step.name === 'Smoke test release image');
  assert(step?.run);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  // Execute the complete workflow block unchanged, substituting only the image
  // environment value so a locally built production image can be checked too.
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, RELEASE_IMAGE: image, GITHUB_SHA: commit.stdout.trim() },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
