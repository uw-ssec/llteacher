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
const productionInputNames = [
  'DATABASE_PASSWORD', 'WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_WEBHOOK_SECRET',
  'OPENROUTER_API_KEY', 'LLMOXIE_API_KEY', 'SESSION_SECRET', 'ENCRYPTION_KEY',
  'BLIND_INDEX_KEY', 'LLMOXIE_BASE_URL',
];
const expectedProductionInputs = {
  DATABASE_PASSWORD: '${{ secrets.DATABASE_PASSWORD }}',
  WORKOS_API_KEY: '${{ secrets.WORKOS_API_KEY }}',
  WORKOS_CLIENT_ID: '${{ secrets.WORKOS_CLIENT_ID }}',
  WORKOS_WEBHOOK_SECRET: '${{ secrets.WORKOS_WEBHOOK_SECRET }}',
  OPENROUTER_API_KEY: '${{ secrets.OPENROUTER_API_KEY }}',
  LLMOXIE_API_KEY: '${{ secrets.LLMOXIE_API_KEY }}',
  SESSION_SECRET: '${{ secrets.SESSION_SECRET }}',
  ENCRYPTION_KEY: '${{ secrets.ENCRYPTION_KEY }}',
  BLIND_INDEX_KEY: '${{ secrets.BLIND_INDEX_KEY }}',
  LLMOXIE_BASE_URL: '${{ vars.LLMOXIE_BASE_URL }}',
};
const productionInputSteps = [
  'Validate production deployment inputs',
  'Bootstrap base infrastructure only when ECR is absent',
  'Register candidate while retaining the current service',
  'Activate migrated candidate',
];

test('production runbook identifies GitHub production inputs and their release behavior', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const production = readme.slice(readme.indexOf('## GitHub Actions: AWS releases only'));
  assert.match(production, /GitHub [`']production[`'] environment secrets/);
  for (const name of productionInputNames.slice(0, -1)) {
    assert.match(production, new RegExp(`\\| \\x60${name}\\x60 \\|`), `${name} missing from production secret table`);
  }
  assert.match(production, /\| Environment variable \| `LLMOXIE_BASE_URL` \|/);
  assert.match(production, /\$\{APP_URL\}\/api\/auth\/callback/);
  assert.match(production, /\$\{APP_URL\}\/api\/webhooks\/workos/);
  assert.match(production, /next (?:successful )?tagged release/);
  assert.match(production, /RDS-managed master credentials/);
});

test('production runbook keeps generated AWS secrets out of operator entry and warns on migration', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const production = readme.slice(readme.indexOf('## GitHub Actions: AWS releases only'));
  assert.doesNotMatch(production, /pulumi(?: -C infra)? config set --secret (?:databasePassword|runtimeSecrets)/);
  assert.match(production, /do not manually edit[^\n]*Secrets Manager/i);
  assert.match(production, /redacted (?:validation )?failure/i);
  assert.match(production, /coordinated (?:data )?migration/i);
});

test('accepted production secrets ADR names GitHub as source and AWS as generated runtime sink', () => {
  const adr = readFileSync(new URL('../../docs/adr/0001-operator-owned-production-secrets.md', import.meta.url), 'utf8');
  assert.match(adr, /status: accepted/);
  assert.match(adr, /GitHub [`']production[`'] environment[^\n]*source of truth/i);
  assert.match(adr, /gives (?:them|these inputs) only to the\s+validation and\s+Pulumi steps/);
  assert.match(adr, /Pulumi[\s\S]{0,100}generated\s+AWS Secrets Manager runtime/i);
  assert.doesNotMatch(adr, /Secrets Manager as the source of truth|operator-owned runtime secret|may read[^\n]*database-password source secret/i);
  assert.match(adr, /RDS-managed master credentials/);
});

test('rollback guidance and generated summary require current production inputs and disclaim secret restoration', t => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rollback = readme.slice(readme.indexOf('### Rollback and rotation'), readme.indexOf('## Verification boundaries'));
  const step = workflow.jobs.production.steps.find(s => s.name === 'Record rollback reference');
  assert(step);
  const dir = mkdtempSync(join(tmpdir(), 'release-rollback-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summaryPath = join(dir, 'summary.md');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, STACK: 'production',
      PREVIOUS_TASK: 'arn:aws:ecs:us-west-2:055237683908:task-definition/llteacher-production-app:6',
      PREVIOUS_DIGEST: `sha256:${'a'.repeat(64)}`,
      ...Object.fromEntries(productionInputNames.map(name => [name, `SENTINEL_${name}`])) },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = readFileSync(summaryPath, 'utf8');
  assert.doesNotMatch(summary, /SENTINEL_/);
  for (const document of [rollback, summary]) {
    for (const name of productionInputNames) assert.match(document, new RegExp(`\\b${name}\\b`));
    assert.match(document, /approved secret-handling session/i);
    assert.match(document, /intended current secret state/i);
    assert.match(document, /older task definition[^\n]*not restore older secret values/i);
  }
});

test('validates production deployment inputs before the first AWS mutation', () => {
  const steps = workflow.jobs.production.steps;
  const install = steps.findIndex(step => step.name === 'Install and build infrastructure on deployment runner');
  const validation = steps.findIndex(step => step.name === 'Validate production deployment inputs');
  const oidc = steps.findIndex(step => step.uses?.startsWith('aws-actions/configure-aws-credentials'));
  const bootstrap = steps.findIndex(step => step.name === 'Bootstrap base infrastructure only when ECR is absent');
  const publication = steps.findIndex(step => step.name === 'Push tested application image');
  assert(install >= 0 && validation > install && oidc > validation && bootstrap > validation && publication > validation);
  assert.equal(steps[validation].run.trim(), 'node infra/dist/validate-production-inputs.js');
});

test('scopes the complete GitHub input set to validation and Pulumi update steps', () => {
  const steps = workflow.jobs.production.steps;
  const byName = name => steps.find(step => step.name === name);
  assert.deepEqual(byName(productionInputSteps[0])?.env, expectedProductionInputs);
  assert.deepEqual(byName(productionInputSteps[1])?.env, expectedProductionInputs);
  assert.deepEqual(byName(productionInputSteps[2])?.env, {
    IMAGE_DIGEST: '${{ steps.image.outputs.digest }}', ...expectedProductionInputs,
  });
  assert.deepEqual(byName(productionInputSteps[3])?.env, {
    CANDIDATE: '${{ steps.candidate.outputs.candidate }}', ...expectedProductionInputs,
  });
});

test('does not expose production secrets to tests artifacts Docker migrations identity checks or verification', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const name of productionInputNames) assert.equal(job.env?.[name], undefined, `job env exposes ${name}`);
    for (const step of job.steps) {
      if (job === workflow.jobs.production && productionInputSteps.includes(step.name)) continue;
      for (const name of productionInputNames) {
        assert.equal(step.env?.[name], undefined, `${step.name ?? step.uses} exposes ${name}`);
        assert(!JSON.stringify(step).includes(`secrets.${name}`), `${step.name ?? step.uses} references secret ${name}`);
      }
    }
  }
});

function assertNoProductionInputTransport(candidateWorkflow) {
  const stringValues = value => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
    return [];
  };
  for (const [jobName, job] of Object.entries(candidateWorkflow.jobs)) {
    for (const step of job.steps) {
      const { env: _approvedStepEnvironment, ...otherStepFields } = step;
      const approvedInputStep = jobName === 'production' && productionInputSteps.includes(step.name);
      for (const value of stringValues(approvedInputStep ? otherStepFields : step)) {
        for (const name of productionInputNames) {
          const protectedExpression = new RegExp(`\\$\\{\\{\\s*(?:secrets|vars)\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`);
          assert(!protectedExpression.test(value), `${step.name ?? step.uses} interpolates ${name} outside approved step env`);
          if (jobName === 'production' && step.name === 'Record rollback reference') {
            assert(!new RegExp(`\\$(?:\\{)?${name}(?:\\}|\\b)`).test(value), `${step.name} expands ${name}`);
          } else if (jobName === 'production') {
            assert(!new RegExp(`\\b${name}\\b`).test(value), `${step.name ?? step.uses} transports ${name} outside approved step env`);
          }
        }
      }
    }
  }
}

test('does not copy secret values through GitHub environment outputs arguments or artifacts', () => {
  assertNoProductionInputTransport(workflow);
});

test('rejects command argument and artifact transport mutations', () => {
  for (const mutate of [
    candidate => { candidate.jobs.production.steps.find(step => step.id === 'candidate').run += '\nnode tool.js "$DATABASE_PASSWORD"'; },
    candidate => { candidate.jobs.production.steps.find(step => step.id === 'candidate').run += '\nprintf "%s" "$WORKOS_API_KEY" > release-artifact/input.txt'; },
    candidate => { candidate.jobs.test.steps.find(step => step.uses?.startsWith('actions/upload-artifact')).with.path = '${{ secrets.ENCRYPTION_KEY }}'; },
    candidate => { candidate.jobs.test.steps.find(step => step.uses?.startsWith('actions/upload-artifact')).with.path = '${{ vars.LLMOXIE_BASE_URL }}'; },
    candidate => { candidate.jobs.test.steps.find(step => step.uses?.startsWith('actions/upload-artifact')).env = { UPLOAD_PATH: '${{ vars.LLMOXIE_BASE_URL }}' }; },
    candidate => { candidate.jobs.production.steps.find(step => step.name === 'Record rollback reference').run += '\necho "$DATABASE_PASSWORD" >> "$GITHUB_STEP_SUMMARY"'; },
  ]) {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    assert.throws(() => assertNoProductionInputTransport(candidate), { name: 'AssertionError' });
  }
});

test('validator CLI prints one safe success line and redacts rejected values', () => {
  const root = new URL('../..', import.meta.url);
  const build = spawnSync('npm', ['run', 'build', '--workspace=infra'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const fake = {
    DATABASE_PASSWORD: 'FakePass123!', WORKOS_API_KEY: 'sk_fake', WORKOS_CLIENT_ID: 'client_fake',
    WORKOS_WEBHOOK_SECRET: 'fake-webhook', OPENROUTER_API_KEY: 'sk-or-fake', LLMOXIE_API_KEY: 'fake-llmoxie',
    SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
    ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    BLIND_INDEX_KEY: Buffer.alloc(32, 3).toString('base64'),
    LLMOXIE_BASE_URL: 'https://llmoxie.example.test/api/v1',
  };
  const cli = 'infra/dist/validate-production-inputs.js';
  const valid = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8', env: fake });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'Production deployment inputs are valid.\n');
  assert.equal(valid.stderr, '');
  const rejected = 'fake rejected value with spaces';
  const invalid = spawnSync(process.execPath, [cli], {
    cwd: root, encoding: 'utf8', env: { ...fake, DATABASE_PASSWORD: rejected },
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /DATABASE_PASSWORD/);
  assert(!invalid.stderr.includes(rejected));
});

test('retains the empty-stack configuration refresh guard', () => {
  const steps = workflow.jobs.production.steps;
  const refresh = steps.find(step => step.name === 'Refresh encrypted stack configuration');
  assert(refresh);
  assert.match(refresh.run, /stack history --stack "\$STACK" --json/);
  assert.match(refresh.run, /if \(\( history_count > 0 \)\); then\s+pulumi -C infra config refresh/);
  assert.match(refresh.run, /No previous deployment; using checked-in stack configuration/);
  for (const name of productionInputNames) assert.equal(refresh.env?.[name], undefined);
});
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
test('the reviewed deploy role is validated before OIDC and caller identity confirms it', () => {
  const steps = workflow.jobs.production.steps;
  const validate = steps.findIndex(s => s.name === 'Validate release target');
  const oidc = steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
  const select = steps.find(s => s.name === 'Validate AWS identity and select Pulumi backend');
  assert(validate >= 0 && oidc > validate);
  assert.equal(steps[validate].env.DEPLOY_ROLE, '${{ vars.AWS_DEPLOY_ROLE_ARN }}');
  assert.match(steps[validate].run, /validate_deploy_role "\$DEPLOY_ROLE"/);
  assert.match(select.run, /--query Arn --output text/);
  assert.match(select.run, /validate_assumed_deploy_role/);
});
test('production runner installs and builds infrastructure before any Pulumi use', () => {
  const steps = workflow.jobs.production.steps;
  const firstPulumi = steps.findIndex(s => s.uses?.startsWith('pulumi/') || s.run?.includes('pulumi '));
  assert(steps.slice(0,firstPulumi).some(s => s.run?.includes('npm ci')));
  assert(steps.slice(0,firstPulumi).some(s => s.run?.includes('npm run build --workspace=infra')));
});
test('Pulumi installation does not invoke an unsupported operation', () => {
  const installer = workflow.jobs.production.steps.find(s => s.uses?.startsWith('pulumi/actions@'));
  assert(installer);
  assert.equal(installer.with?.command, undefined);
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
test('configuration refresh skips a stack without deployment history and refreshes an established stack', t => {
  const step=workflow.jobs.production.steps.find(s=>s.name==='Refresh encrypted stack configuration');
  assert(step);
  for (const scenario of [
    { name: 'new-stack', history: '[]', succeeds: true, expectedRefreshes: 0 },
    { name: 'established-stack', history: '[{"version":1}]', succeeds: true, expectedRefreshes: 1 },
    { name: 'malformed-history', history: 'not-json', succeeds: false, expectedRefreshes: 0 },
  ]) {
    const dir=mkdtempSync(join(tmpdir(),'release-config-refresh-test-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const calls=join(dir,'calls');
    writeFileSync(join(dir,'pulumi'),`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,args.join(' ')+'\\n');
if(args.includes('history')) process.stdout.write(process.env.PULUMI_HISTORY+'\\n');
else if(args.includes('refresh') && process.env.PULUMI_HISTORY==='[]') {
  process.stderr.write('error: getting latest configuration: no previous deployment\\n');
  process.exit(1);
}
`,{mode:0o755});
    const result=spawnSync('bash',['-euo','pipefail','-c',step.run],{
      cwd:new URL('../..',import.meta.url),
      encoding:'utf8',
      env:{...process.env,PATH:`${dir}:${process.env.PATH}`,STACK:'production',CALLS:calls,PULUMI_HISTORY:scenario.history},
    });
    assert.equal(result.status===0,scenario.succeeds,`${scenario.name}: ${result.stderr}`);
    const invocations=readFileSync(calls,'utf8').trim().split('\n');
    assert.equal(invocations.filter(call=>call.includes('stack history')).length,1,scenario.name);
    assert.equal(invocations.filter(call=>call.includes('config refresh')).length,scenario.expectedRefreshes,scenario.name);
  }
});
test('all workflow shell steps parse under bash', () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.run) {
    const result=spawnSync('bash',['-n'],{input:step.run,encoding:'utf8'});
    assert.equal(result.status,0,`${step.name}: ${result.stderr}`);
  }
});
test('refreshed workflow configuration passes the selected hosted zone and certificate into the release guard', () => {
  const step = workflow.jobs.production.steps.find(s => s.name === 'Validate refreshed production configuration');
  const stub = `pulumi() { case "$5" in aws:region) echo us-west-2;; environment) echo production;; domainReady) echo true;; domainName) echo llteacher.org;; hostedZoneId) echo "$TEST_HOSTED_ZONE_ID";; certificateArn) echo "$TEST_CERTIFICATE_ARN";; *) return 1;; esac; }`;
  for (const [hostedZoneId, certificate] of [
    ['', 'arn:aws:acm:us-west-2:055237683908:certificate/11111111-2222-3333-4444-555555555555'],
    ['Z0123456789ABCDEFGHIJ', ''],
    ['Z0123456789ABCDEFGHIJ', 'arn:aws:acm:us-west-2:055237683908:certificate/11111111-2222-3333-4444-555555555555'],
  ]) {
    const result = spawnSync('bash', ['-c', `${stub}\n${step.run}`], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, AWS_REGION: 'us-west-2', STACK: 'production', PULUMI_BACKEND_URL: 's3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra', TEST_HOSTED_ZONE_ID: hostedZoneId, TEST_CERTIFICATE_ARN: certificate },
    });
    assert.equal(result.status === 0, hostedZoneId !== '' && certificate !== '', result.stderr);
    if (!hostedZoneId) assert.match(result.stderr, /hostedZoneId/);
    if (!certificate) assert.match(result.stderr, /certificateArn/);
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
