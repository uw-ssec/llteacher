import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
const stack = 'production';
const backend = 's3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra';
const arn = 'arn:aws:ecs:us-west-2:123456789012:task-definition/llteacher-production-app:7';
const digest = `sha256:${'a'.repeat(64)}`;
function fixture(t, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputs = { clusterName: 'production-cluster', appSubnetIds: ['subnet-01234567'], appSecurityGroupId: 'sg-01234567', ecrRepositoryUrl: '123456789012.dkr.ecr.us-west-2.amazonaws.com/llteacher-production/app', logGroupName: '/ecs/llteacher-production-app', ...scenario.outputs };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ outputs, arn, digest, ...scenario }));
  const stub = `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const dir=process.env.FIXTURE; const s=JSON.parse(fs.readFileSync(dir+'/scenario.json')); const tool=path.basename(process.argv[1]); const args=process.argv.slice(2); const cmd=args.join(' ');
fs.appendFileSync(dir+'/calls', JSON.stringify([tool,...args])+'\\n');
function out(x){ console.log(typeof x==='string'?x:JSON.stringify(x)); }
if(tool==='pulumi') {
 if(cmd.includes('stack output')) { if(s.stackError) process.exit(9); out(s.outputs); }
 else if(cmd.includes(' up ') && s.upError) process.exit(8);
} else if(cmd.includes('ecr describe-repositories')) {
 if(s.ecrError){ console.error('An error occurred ('+s.ecrError+') when calling DescribeRepositories'); process.exit(254); }
 out({repositories:[{repositoryUri:s.outputs.ecrRepositoryUrl}]});
} else if(cmd.includes('ecs list-services')) out({serviceArns:s.liveService?['arn:aws:ecs:us-west-2:123456789012:service/live']:[]});
else if(cmd.includes('ecs describe-services')) out({services:[{status:'ACTIVE',taskDefinition:s.arn}],failures:[]});
else if(cmd.includes('ecs describe-task-definition')) out({taskDefinition:{containerDefinitions:[{name:'app',image:s.outputs.ecrRepositoryUrl+'@'+s.digest}]}});
else if(cmd.includes('ecs run-task')) out({tasks:[{taskArn:'arn:aws:ecs:us-west-2:123456789012:task/production-cluster/0123456789abcdef0123456789abcdef'}],failures:[]});
else if(cmd.includes('ecs wait tasks-stopped')) {if(s.waitError) process.exit(255);}
else if(cmd.includes('ecs describe-tasks')) {
 const n=fs.existsSync(dir+'/count')?Number(fs.readFileSync(dir+'/count')):0; fs.writeFileSync(dir+'/count',String(n+1));
 const app={name:'app',reason:s.missingExit&&n===0?'CannotPullContainerError: image unavailable':undefined,logStreamName:s.missingExit&&n===0?undefined:'app/production/task-id'};
 if(!(s.missingExit&&n===0)) app.exitCode=s.failFirst&&n===0?1:0;
 out({tasks:[{taskArn:'arn:aws:ecs:us-west-2:123456789012:task/production-cluster/0123456789abcdef0123456789abcdef',lastStatus:s.running?'RUNNING':'STOPPED',stoppedReason:s.missingExit&&n===0?'CannotPullContainerError: image unavailable':'Essential container exited',containers:[{name:'sidecar',exitCode:0},app]}],failures:[]});
} else { console.error('Unexpected call '+tool+' '+cmd); process.exit(91); }
`;
  for (const tool of ['aws', 'pulumi']) writeFileSync(join(dir, tool), stub, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir, AWS_REGION: 'us-west-2', PULUMI_BACKEND_URL: backend, GITHUB_OUTPUT: join(dir, 'output'), GITHUB_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`, LLTEACHER_AWS_MIGRATION_ATTEMPTS: '2', LLTEACHER_AWS_MIGRATION_DELAY_SECONDS: '0' };
  return {
    run: (script, args = [stack], overrides = {}) => spawnSync('bash', [join(scripts, script), ...args], { env: { ...env, ...overrides }, encoding: 'utf8' }),
    calls: () => { try { return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
    output: () => { try { return readFileSync(join(dir, 'output'), 'utf8'); } catch { return ''; } },
  };
}
function success(result) { assert.equal(result.status, 0, result.stderr); }
function failure(result) { assert.notEqual(result.status, 0, result.stdout); }
function noMutation(f) { assert.equal(f.calls().filter(c => c.includes('set') || c.includes('up') || c.includes('run-task')).length, 0); }

test('bootstrap rejects stack read errors before changing service configuration', t => {
  const f = fixture(t, { stackError: true }); failure(f.run('bootstrap-aws-infra.sh')); noMutation(f);
});
test('bootstrap refuses a live ECS service even when stack service output is absent', t => {
  const f = fixture(t, { liveService: true }); failure(f.run('bootstrap-aws-infra.sh')); noMutation(f);
});
test('bootstrap creates base infrastructure only and returns repository URL', t => {
  const f = fixture(t); const result = f.run('bootstrap-aws-infra.sh'); success(result);
  assert.equal(result.stdout.trim(), '123456789012.dkr.ecr.us-west-2.amazonaws.com/llteacher-production/app');
  assert(f.calls().some(c => c.includes('provisionService') && c.at(-1) === 'false'));
});
test('repository authentication errors cannot trigger bootstrap', t => {
  const f = fixture(t, { ecrError: 'AccessDeniedException' }); failure(f.run('prepare-aws-release.sh', [stack, 'repository'])); noMutation(f);
});
test('only repository-not-found permits base bootstrap', t => {
  const f = fixture(t, { ecrError: 'RepositoryNotFoundException' }); success(f.run('prepare-aws-release.sh', [stack, 'repository']));
  assert(f.calls().some(c => c.includes('up')));
});
test('candidate preserves actual active image rollback before failing up and previews configured candidate', t => {
  const f = fixture(t, { outputs: { clusterName:'production-cluster', serviceName:'production-service', serviceTaskDefinition:arn, imageDigest:`sha256:${'d'.repeat(64)}`, ecrRepositoryUrl:'123456789012.dkr.ecr.us-west-2.amazonaws.com/llteacher-production/app' }, upError:true });
  failure(f.run('prepare-aws-release.sh', [stack, 'candidate']));
  assert(f.output().includes(`previous_task_definition=${arn}`));
  assert(f.output().includes(`previous_digest=${digest}`));
  const calls = f.calls(); const preview = calls.findIndex(c => c.includes('preview')); const up = calls.findIndex(c => c.includes('up'));
  assert(preview > calls.findIndex(c => c.includes('imageDigest') && c.includes('set')));
  assert(preview > calls.findIndex(c => c.includes('serviceTaskDefinition') && c.includes('set')));
  assert(up > preview);
});
test('candidate does not mutate after output fetch failure', t => {
  const f = fixture(t, { stackError: true }); failure(f.run('prepare-aws-release.sh', [stack,'candidate'])); noMutation(f);
});
test('migration retries only terminal failed app container and ignores sidecar success', t => {
  const f = fixture(t, { failFirst:true }); success(f.run('run-aws-migrations.sh', [stack,arn]));
  assert.equal(f.calls().filter(c => c.includes('run-task')).length,2);
});
test('migration retries a terminal task whose app never started and prints bounded diagnostics', t => {
  const f = fixture(t, { missingExit:true });
  const result = f.run('run-aws-migrations.sh', [stack,arn]);
  success(result);
  assert.equal(f.calls().filter(c => c.includes('run-task')).length,2);
  assert.match(result.stderr,/0123456789abcdef0123456789abcdef/);
  assert.match(result.stderr,/CannotPullContainerError/);
  assert.match(result.stderr,/\/ecs\/llteacher-production-app/);
  assert.match(result.stderr,/app\/app\/0123456789abcdef0123456789abcdef/);
  assert.match(result.stderr,/may not exist when the container failed before startup/);
});
test('migration waiter timeout aborts without starting a second live task', t => {
  const f = fixture(t, {waitError:true,running:true}); failure(f.run('run-aws-migrations.sh',[stack,arn]));
  assert.equal(f.calls().filter(c => c.includes('run-task')).length,1);
});
test('migration requires terminal status even after successful waiter', t => {
  const f = fixture(t,{running:true}); failure(f.run('run-aws-migrations.sh',[stack,arn]));
  assert.equal(f.calls().filter(c => c.includes('run-task')).length,1);
});
test('migration rejects invalid candidate and network contracts without launching', t => {
  for (const candidate of ['None','task-test','arn:aws:ecs:us-east-1:123456789012:task-definition/app:7']) {
    const f=fixture(t); failure(f.run('run-aws-migrations.sh',[stack,candidate])); noMutation(f);
  }
  const f=fixture(t,{outputs:{clusterName:'',appSubnetIds:[],appSecurityGroupId:'None'}});
  failure(f.run('run-aws-migrations.sh',[stack,arn])); noMutation(f);
});
test('all helpers reject non-production stacks before API calls', t => {
  for (const script of ['bootstrap-aws-infra.sh','prepare-aws-release.sh','run-aws-migrations.sh']) {
    for (const invalid of ['', 'local', 'example/llteacher-infra/production', 'staging']) {
      const f=fixture(t); failure(f.run(script,[invalid, ...(script==='run-aws-migrations.sh'?[arn]:script==='prepare-aws-release.sh'?['repository']:[])])); assert.equal(f.calls().length,0);
    }
  }
});

test('all helpers reject empty or altered Pulumi backends before API calls', t => {
  for (const script of ['bootstrap-aws-infra.sh','prepare-aws-release.sh','run-aws-migrations.sh']) {
    const args = [stack, ...(script==='run-aws-migrations.sh'?[arn]:script==='prepare-aws-release.sh'?['repository']:[])];
    for (const PULUMI_BACKEND_URL of ['', `${backend}-wrong`]) {
      const f=fixture(t); failure(f.run(script,args,{PULUMI_BACKEND_URL})); assert.equal(f.calls().length,0);
    }
  }
});

test('all helpers reject empty or wrong regions before API calls', t => {
  for (const script of ['bootstrap-aws-infra.sh','prepare-aws-release.sh','run-aws-migrations.sh']) {
    const args = [stack, ...(script==='run-aws-migrations.sh'?[arn]:script==='prepare-aws-release.sh'?['repository']:[])];
    for (const AWS_REGION of ['', 'us-east-1']) {
      const f=fixture(t); failure(f.run(script,args,{AWS_REGION})); assert.equal(f.calls().length,0);
    }
  }
});

test('release validation rejects a different AWS account', () => {
  const command = `. "${join(scripts, 'aws-release-common.sh')}"; validate_aws_account "$1"`;
  for (const account of ['', '000000000000', '055237683909']) {
    const result = spawnSync('bash', ['-c', command, 'validate', account], {
      env: { ...process.env, AWS_REGION: 'us-west-2', PULUMI_BACKEND_URL: backend },
      encoding: 'utf8',
    });
    failure(result);
    assert.match(result.stderr, /AWS account must be 055237683908/);
  }
});

test('release validation helpers explain invalid workflow values', () => {
  const command = `. "${join(scripts, 'aws-release-common.sh')}"; validate_deploy_role bad-role`;
  const result = spawnSync('bash', ['-c', command], { env: { ...process.env, AWS_REGION: 'us-west-2' }, encoding: 'utf8' });
  failure(result);
  assert.match(result.stderr, /AWS_DEPLOY_ROLE_ARN must be a valid IAM role ARN/);
});

test('refreshed production config rejects stale regions and non-HTTPS activation', () => {
  for (const [region, environment, domainReady, domainName, message] of [
    ['us-east-1', 'production', 'true', 'learn.example.edu', 'still uses aws:region us-east-1'],
    ['us-west-2', 'production', 'false', '', 'requires domainReady=true'],
  ]) {
    const command = `. "${join(scripts, 'aws-release-common.sh')}"; validate_refreshed_stack_config "$1" "$2" "$3" "$4"`;
    const result = spawnSync('bash', ['-c', command, 'validate', region, environment, domainReady, domainName], { env: { ...process.env, AWS_REGION: 'us-west-2' }, encoding: 'utf8' });
    failure(result);
    assert.match(result.stderr, new RegExp(message));
  }
});
