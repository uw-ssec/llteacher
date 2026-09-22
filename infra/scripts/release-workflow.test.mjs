import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const workflow = require('js-yaml').load(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
test('production operations use the S3 backend and historical instructions explicitly defer to the new design', () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  for (const path of ['infra/README.md', 'docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md']) {
    const document = read(path);
    for (const identity of ['s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra',
      'alias/llteacher-pulumi-state', 'repo:uw-ssec/llteacher:environment:production', '`production`']) {
      assert(document.includes(identity), `${path}: missing ${identity}`);
    }
    assert.doesNotMatch(document, /PULUMI_ACCESS_TOKEN|organization\/llteacher-infra\/production|pulumi:cloud/);
  }
  for (const path of ['docs/superpowers/plans/2026-09-21-minimal-production-infrastructure-implementation.md',
    'docs/superpowers/plans/2026-09-21-infrastructure-implementation-handoff.md']) {
    assert.match(read(path).slice(0, 900), /Backend supersession[\s\S]*2026-09-22-s3-pulumi-backend-design\.md/);
  }
  const scripts = JSON.parse(read('infra/package.json')).scripts;
  assert.equal(scripts['pulumi:cloud'], undefined);
  assert.equal(scripts['pulumi:production'], 'npm run build && PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra AWS_REGION=us-west-2 pulumi --stack production');
});
test('production uses the reviewed S3 backend without a Pulumi Cloud token', () => {
  const env = workflow.jobs.production.env;
  assert.equal(env.STACK, '${{ vars.PULUMI_STACK }}');
  assert.equal(env.PULUMI_BACKEND_URL, '${{ vars.PULUMI_BACKEND_URL }}');
  assert.equal(env.PULUMI_ACCESS_TOKEN, undefined);
  assert(!readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8').includes('PULUMI_ACCESS_TOKEN'));
});
test('AWS identity and S3 backend are selected before stack reads or mutations', () => {
  const steps = workflow.jobs.production.steps;
  const oidc = steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
  const select = steps.findIndex(s => s.name === 'Validate AWS identity and select Pulumi backend');
  const refresh = steps.findIndex(s => s.name === 'Refresh encrypted stack configuration');
  const mutate = steps.findIndex(s => s.name === 'Bootstrap base infrastructure only when ECR is absent');
  assert(oidc >= 0 && select > oidc && refresh > select && mutate > refresh);
  assert.match(steps[select].run, /aws sts get-caller-identity/);
  assert.match(steps[select].run, /validate_aws_account/);
  assert.match(steps[select].run, /pulumi login "\$PULUMI_BACKEND_URL"/);
  assert.match(steps[select].run, /stack select "\$STACK" --non-interactive/);
});
test('production runner installs and builds infrastructure before any Pulumi use', () => {
  const steps = workflow.jobs.production.steps;
  const firstPulumi = steps.findIndex(s => s.uses?.startsWith('pulumi/') || s.run?.includes('pulumi '));
  assert(steps.slice(0,firstPulumi).some(s => s.run?.includes('npm ci')));
  assert(steps.slice(0,firstPulumi).some(s => s.run?.includes('npm run build --workspace=infra')));
});
test('OIDC belongs exclusively to protected tag-only production job', () => {
  assert.equal(workflow.permissions['id-token'], undefined);
  assert.equal(workflow.jobs.production.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.production.environment, 'production');
  assert.match(workflow.jobs.production.if, /refs\/tags\/v/);
  assert.equal(workflow.jobs.test.permissions?.['id-token'], undefined);
});
test('production consumes tested saved image with no second Docker build', () => {
  const tests=workflow.jobs.test.steps, production=workflow.jobs.production.steps;
  assert.equal([...tests,...production].filter(s => s.uses?.startsWith('docker/build-push-action')).length,1);
  assert(tests.some(s => s.run?.includes('docker save')));
  assert(tests.some(s => s.uses?.startsWith('actions/upload-artifact')));
  assert(production.some(s => s.uses?.startsWith('actions/download-artifact')));
  assert(production.some(s => s.run?.includes('sha256sum -c') && s.run.includes('docker load')));
  assert(!production.some(s => s.run?.match(/docker build\b/)));
});
test('migration receives same qualified stack and rollback summary survives candidate failures', () => {
  const steps=workflow.jobs.production.steps;
  const migration=steps.find(s => s.run?.includes('run-aws-migrations.sh'));
  assert.match(migration.run,/"\$STACK"/);
  const summary=steps.find(s => s.run?.includes('GITHUB_STEP_SUMMARY'));
  assert.equal(summary.if,'always()');
  assert.match(summary.env.PREVIOUS_DIGEST,/steps.candidate.outputs.previous_digest/);
});
test('production release remains tag-only and does not restore staging auto-deploy', () => {
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.on.push.branches, undefined);
  assert.equal(workflow.jobs.production.environment, 'production');
});
test('refreshed stack is validated before the first AWS mutation', () => {
  const steps=workflow.jobs.production.steps;
  const refresh=steps.findIndex(s=>s.name==='Refresh encrypted stack configuration');
  const validate=steps.findIndex(s=>s.name==='Validate refreshed production configuration');
  const mutate=steps.findIndex(s=>s.name==='Bootstrap base infrastructure only when ECR is absent');
  assert(refresh >= 0 && validate > refresh && mutate > validate);
  assert.match(steps[validate].run,/validate_refreshed_stack_config/);
});
test('all workflow shell steps parse under bash', () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.run) {
    const result=spawnSync('bash',['-n'],{input:step.run,encoding:'utf8'});
    assert.equal(result.status,0,`${step.name}: ${result.stderr}`);
  }
});
test('artifact verification loads exactly the tested image and refuses altered bytes, commits or image identity', t => {
  const step=workflow.jobs.production.steps.find(s=>s.name==='Verify and load tested release image');
  assert(step);
  const sha='b'.repeat(40), id=`sha256:${'c'.repeat(64)}`;
  for (const scenario of ['valid','tamper','wrong-commit','wrong-image','wrong-label']) {
    const dir=mkdtempSync(join(tmpdir(),'release-artifact-test-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const artifact=join(dir,'release-artifact'); mkdirSync(artifact);
    mkdirSync(join(dir,'infra','scripts'),{recursive:true});
    writeFileSync(join(dir,'infra','scripts','aws-release-common.sh'),readFileSync(new URL('./aws-release-common.sh', import.meta.url)));
    const contents={'image.tar':'saved image fixture','image.id':`${id}\n`,'commit.sha':`${scenario==='wrong-commit'?'a'.repeat(40):sha}\n`};
    for(const [name,data] of Object.entries(contents)) writeFileSync(join(artifact,name),data);
    writeFileSync(join(artifact,'checksums.txt'),Object.entries(contents).map(([name,data])=>`${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n')+'\n');
    if(scenario==='tamper') writeFileSync(join(artifact,'image.tar'),'altered artifact');
    writeFileSync(join(dir,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2);
if(a[0]==='load') fs.writeFileSync(process.env.FIXTURE+'/loaded','yes');
else if(a.includes('{{.Id}}')) console.log(process.env.SCENARIO==='wrong-image'?'sha256:wrong':process.env.IMAGE_ID);
else console.log(process.env.SCENARIO==='wrong-label'?'wrong':process.env.GITHUB_SHA);
`,{mode:0o755});
    const result=spawnSync('bash',['-euo','pipefail','-c',step.run],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:`${dir}:${process.env.PATH}`,FIXTURE:dir,GITHUB_SHA:sha,IMAGE_ID:id,SCENARIO:scenario}});
    if(scenario==='valid') assert.equal(result.status,0,result.stderr);
    else {
      assert.notEqual(result.status,0,scenario);
      if (scenario==='wrong-commit') assert.match(result.stderr,/Artifact commit does not match GITHUB_SHA/);
      if (scenario==='wrong-image') assert.match(result.stderr,/Loaded image ID does not match the tested artifact/);
      if (scenario==='wrong-label') assert.match(result.stderr,/Loaded image revision label does not match GITHUB_SHA/);
    }
    if(scenario==='tamper'||scenario==='wrong-commit') assert.equal(existsSync(join(dir,'loaded')),false);
  }
});
