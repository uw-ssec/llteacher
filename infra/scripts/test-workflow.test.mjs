import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const workflow = require('js-yaml').load(
  readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'),
);

test('test workflow runs for pull requests and pushes to staging only', () => {
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push.branches, ['staging']);
  assert(!workflow.on.push.branches.includes('llteacher01'));
});
