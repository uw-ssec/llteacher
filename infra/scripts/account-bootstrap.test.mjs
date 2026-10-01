import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../account/bootstrap.sh', import.meta.url));
const account = '055237683908';

// A stateful stand-in for the subset of the AWS CLI the bootstrap uses.
const fakeAws = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);
const positional = [], opts = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
  const key = argv[i].slice(2), values = [];
  // Options take one value, except the variadic --tags.
  while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && (values.length === 0 || key === 'tags')) values.push(argv[++i]);
  opts[key] = values.length > 1 ? values : values[0];
}
const [service, op] = positional;
state.calls.push(service + ' ' + op);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const file = v => fs.readFileSync(v.replace('file://', ''), 'utf8');
const fail = code => { save(); process.stderr.write('An error occurred (' + code + ') when calling ' + op + '\n'); process.exit(254); };
const emit = value => {
  save();
  if (value === undefined) process.exit(0);
  for (const key of (opts.query && !opts.query.includes('[') ? opts.query.split('.') : [])) value = value?.[key];
  process.stdout.write(opts.output === 'text' && typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
  process.exit(0);
};
for (const code of state.denied ?? []) if (code === service + ' ' + op) fail('AccessDenied');
const keyArn = 'arn:aws:kms:us-west-2:${account}:key/1111';
const keyMeta = () => ({ KeyMetadata: { Arn: keyArn, AWSAccountId: '${account}', KeyState: state.key.state ?? 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT' } });
const b = state.bucket, role = state.role;
const serviceLinkedRoleNames = {
  'elasticloadbalancing.amazonaws.com': 'AWSServiceRoleForElasticLoadBalancing',
  'rds.amazonaws.com': 'AWSServiceRoleForRDS',
};
switch (service + ' ' + op) {
  case 'configure get': opts.output = 'text'; emit('us-west-2');
  case 'sts get-caller-identity': emit({ Account: state.account, Arn: 'arn:aws:iam::' + state.account + ':user/admin' });
  case 'kms describe-key':
    if (!state.key || (opts['key-id'].startsWith('alias/') && !state.alias)) fail('NotFoundException');
    emit(keyMeta());
  case 'kms list-aliases': emit({ Aliases: state.alias ? [{ AliasName: state.alias }] : [] });
  case 'kms create-key': state.key = { policy: file(opts.policy) }; emit(keyMeta());
  case 'kms create-alias': state.alias = opts['alias-name']; emit();
  case 'kms enable-key-rotation': state.key.rotation = true; emit();
  case 'kms get-key-rotation-status': emit({ KeyRotationEnabled: !!state.key.rotation });
  case 'kms get-key-policy': emit({ Policy: state.key.policy });
  case 's3api head-bucket': if (!b) fail('404'); emit({});
  case 's3api create-bucket': state.bucket = { location: 'us-west-2' }; emit({});
  case 's3api put-bucket-ownership-controls': b.ownership = true; emit();
  case 's3api put-public-access-block': b.pab = true; emit();
  case 's3api put-bucket-versioning': b.versioning = true; emit();
  case 's3api put-bucket-encryption':
    // Like S3, new buckets block SSE-C unless a rule says otherwise.
    b.encryption = JSON.parse(file(opts['server-side-encryption-configuration']));
    for (const rule of b.encryption.Rules) rule.BlockedEncryptionTypes ??= { EncryptionType: ['SSE-C'] };
    emit();
  case 's3api put-bucket-policy': b.policy = file(opts.policy); emit();
  case 's3api put-bucket-tagging': b.tags = true; emit();
  case 's3api get-bucket-location': emit({ LocationConstraint: b.location });
  case 's3api get-bucket-ownership-controls': emit({ OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } });
  case 's3api get-public-access-block': if (!b.pab) fail('NoSuchPublicAccessBlockConfiguration'); emit({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
  case 's3api get-bucket-versioning': emit(b.versioning ? { Status: 'Enabled' } : {});
  case 's3api get-bucket-encryption': emit({ ServerSideEncryptionConfiguration: b.encryption });
  case 's3api get-bucket-policy': if (!b.policy) fail('NoSuchBucketPolicy'); emit({ Policy: b.policy });
  case 's3api get-bucket-tagging': emit({ TagSet: b.tags ? [{ Key: 'Project', Value: 'llteacher' }, { Key: 'Environment', Value: 'production' }, { Key: 'ManagedBy', Value: 'bootstrap' }] : [] });
  case 's3api get-bucket-lifecycle-configuration': fail('NoSuchLifecycleConfiguration');
  case 'iam get-open-id-connect-provider': if (!state.oidc) fail('NoSuchEntity'); emit({ Url: 'token.actions.githubusercontent.com', ClientIDList: ['sts.amazonaws.com'] });
  case 'iam create-open-id-connect-provider': state.oidc = true; emit({});
  case 'iam get-policy': {
    const p = state.policies[opts['policy-arn']];
    if (!p) fail('NoSuchEntity');
    emit({ Policy: { Arn: opts['policy-arn'], DefaultVersionId: 'v1' } });
  }
  case 'iam get-policy-version': emit({ PolicyVersion: { Document: JSON.parse(state.policies[opts['policy-arn']]) } });
  case 'iam create-policy': state.policies['arn:aws:iam::${account}:policy/' + opts['policy-name']] = file(opts['policy-document']); emit({});
  case 'iam list-roles': emit({ Roles: [] });
  case 'iam get-role': {
    if (opts['role-name'].startsWith('AWSServiceRoleFor')) {
      if (!(state.serviceLinkedRoles ?? []).includes(opts['role-name'])) fail('NoSuchEntity');
      const service = Object.entries(serviceLinkedRoleNames).find(([, name]) => name === opts['role-name'])[0];
      emit({ Role: { RoleName: opts['role-name'], Path: '/aws-service-role/' + service + '/' } });
    }
    if (!role) fail('NoSuchEntity');
    emit({ Role: { AssumeRolePolicyDocument: JSON.parse(role.trust) } });
  }
  case 'iam create-service-linked-role': {
    const roleName = serviceLinkedRoleNames[opts['aws-service-name']];
    if (!roleName) fail('InvalidInput');
    state.serviceLinkedRoles ??= [];
    if (!state.serviceLinkedRoles.includes(roleName)) state.serviceLinkedRoles.push(roleName);
    emit({ Role: { RoleName: roleName, Path: '/aws-service-role/' + opts['aws-service-name'] + '/' } });
  }
  case 'iam create-role': state.role = { trust: file(opts['assume-role-policy-document']), attached: [] }; emit({});
  case 'iam list-role-policies': emit({ PolicyNames: [] });
  case 'iam list-attached-role-policies': emit({ AttachedPolicies: role.attached.map(PolicyArn => ({ PolicyArn })) });
  case 'iam attach-role-policy': if (!role.attached.includes(opts['policy-arn'])) role.attached.push(opts['policy-arn']); emit();
  default:
    if (service === 'ec2' || service === 'acm') emit('');
    fail('UnexpectedFakeCall ' + service + ' ' + op);
}
`;

const mutating = call => /^(\S+) (create|put|attach|enable|update|delete|tag)/.test(call);

function setup(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'account-bootstrap-'));
  writeFileSync(join(dir, 'aws'), fakeAws);
  chmodSync(join(dir, 'aws'), 0o755);
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ account, calls: [], policies: {}, ...state }));
  const run = (mode, input = '') => {
    const result = spawnSync('bash', [script, mode], {
      input, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AWS_STATE: statePath, TMPDIR: dir },
    });
    const next = JSON.parse(readFileSync(statePath, 'utf8'));
    const calls = next.calls;
    writeFileSync(statePath, JSON.stringify({ ...next, calls: [] }));
    return { ...result, calls, state: next };
  };
  const edit = change => {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    change(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  return { run, edit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('check on an empty account plans every prerequisite without mutating', t => {
  const { run, cleanup } = setup();
  t.after(cleanup);
  const result = run('check');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.filter(mutating), []);
  const docs = ['pulumi-state-kms-key-policy.json', 'pulumi-state-bucket-policy.json', 'github-oidc-trust-policy.json', 'runtime-permissions-boundary.json',
    'github-deploy-policy.template.json', 'github-compute-policy.json', 'github-data-policy.json', 'github-network-policy.json'];
  for (const doc of docs) assert(result.stdout.includes(`--- ${doc}`), `missing review JSON: ${doc}`);
  assert.match(result.stdout, /"Sid": "GitHubProductionEnvironment"/);
  assert.match(result.stdout, /rendered after key creation/);
  for (const plan of ['KMS key', 'state bucket', 'GitHub OIDC provider', 'all five managed policies', 'deploy role',
    'service-linked role AWSServiceRoleForElasticLoadBalancing', 'service-linked role AWSServiceRoleForRDS']) {
    assert.match(result.stdout, new RegExp(`apply would create: ${plan}`));
  }
});

test('apply creates everything, verifies it, and a re-run changes nothing', t => {
  const { run, cleanup } = setup();
  t.after(cleanup);
  const apply = run('apply', 'yes\n');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(apply.state.policies[`arn:aws:iam::${account}:policy/llteacher-production-deploy-state`].includes('${KMS_KEY_ARN}'), false);
  assert.equal(Object.keys(apply.state.policies).length, 5);
  assert.deepEqual(apply.state.role.attached.map(a => a.split('/').pop()).sort(),
    ['llteacher-production-deploy-compute', 'llteacher-production-deploy-data', 'llteacher-production-deploy-network', 'llteacher-production-deploy-state']);
  assert.deepEqual(apply.state.serviceLinkedRoles.sort(),
    ['AWSServiceRoleForElasticLoadBalancing', 'AWSServiceRoleForRDS']);
  assert.match(apply.stdout, /AWS_DEPLOY_ROLE_ARN = arn:aws:iam::055237683908:role\/llteacher-production-deploy/);

  const check = run('check');
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(check.calls.filter(mutating), []);
  assert.doesNotMatch(check.stdout, /would create|would attach/);
  assert.match(check.stdout, /rendered with arn:aws:kms:us-west-2:055237683908:key\/1111/);
  assert.match(check.stdout, /"Resource": "arn:aws:kms:us-west-2:055237683908:key\/1111"/);
  assert.doesNotMatch(apply.stdout, /--- github-compute-policy\.json/);
  assert.match(check.stdout, /verified: deploy role llteacher-production-deploy with four grants/);
  assert.match(check.stdout, /verified: service-linked role AWSServiceRoleForElasticLoadBalancing/);
  assert.match(check.stdout, /verified: service-linked role AWSServiceRoleForRDS/);

  const reapply = run('apply', 'yes\n');
  assert.equal(reapply.status, 0, reapply.stderr);
  assert.deepEqual(reapply.calls.filter(mutating).filter(c => c !== 'iam attach-role-policy'), []);
});

test('apply requires typed confirmation before any read or mutation', t => {
  const { run, cleanup } = setup();
  t.after(cleanup);
  const result = run('apply', 'no\n');
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ['configure get', 'sts get-caller-identity']);
});

for (const [name, state, message] of [
  ['wrong account', { account: '111111111111' }, /Wrong AWS account/],
  ['denied read', { denied: ['iam get-role'] }, /Read failed; do not interpret this as absence/],
  ['bucket without key', { bucket: { location: 'us-west-2' } }, /Existing bucket without known key/],
]) {
  test(`stops without mutating on ${name}`, t => {
    const { run, cleanup } = setup(state);
    t.after(cleanup);
    const result = run('apply', 'yes\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls.filter(mutating), []);
  });
}

for (const [name, change, message] of [
  ['managed policy', s => { s.policies[`arn:aws:iam::${account}:policy/llteacher-production-deploy-compute`] = '{"Version":"2012-10-17","Statement":[]}'; }, /Unexpected managed policy llteacher-production-deploy-compute/],
  ['role trust', s => { s.role.trust = '{"Version":"2012-10-17","Statement":[]}'; }, /Unexpected role trust/],
  ['key policy', s => { s.key.policy = '{"Version":"2012-10-17","Statement":[]}'; }, /Unexpected key policy/],
]) {
  test(`existing mismatched ${name} stops instead of being overwritten`, t => {
    const { run, edit, cleanup } = setup();
    t.after(cleanup);
    assert.equal(run('apply', 'yes\n').status, 0);
    edit(change);
    const result = run('apply', 'yes\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls.filter(mutating), []);
  });
}

const existingKey = () => ({
  key: { policy: readFileSync(new URL('../account/pulumi-state-kms-key-policy.json', import.meta.url), 'utf8'), rotation: true },
  alias: 'alias/llteacher-pulumi-state',
});

test('an existing KMS key is reused for the bucket and policies, never recreated', t => {
  const { run, cleanup } = setup(existingKey());
  t.after(cleanup);
  const check = run('check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /exists: kms=true bucket=false/);
  assert.match(check.stdout, /rendered with arn:aws:kms:us-west-2:055237683908:key\/1111/);
  assert.deepEqual(check.calls.filter(mutating), []);

  const apply = run('apply', 'yes\n');
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(apply.calls.filter(call => call.startsWith('kms ') && mutating(call)), []);
  assert.equal(apply.state.bucket.encryption.Rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID, 'arn:aws:kms:us-west-2:055237683908:key/1111');
  assert(apply.state.policies[`arn:aws:iam::${account}:policy/llteacher-production-deploy-state`].includes('arn:aws:kms:us-west-2:055237683908:key/1111'));
});

for (const [name, change, message] of [
  ['pending deletion', s => { s.key.state = 'PendingDeletion'; }, /Unexpected key metadata/],
  ['rotation disabled', s => { s.key.rotation = false; }, /Key rotation is not enabled/],
]) {
  test(`an existing KMS key that is ${name} stops without creating a replacement`, t => {
    const state = existingKey();
    change(state);
    const { run, cleanup } = setup(state);
    t.after(cleanup);
    const result = run('apply', 'yes\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls.filter(mutating), []);
  });
}

test('the script never deletes, disables or schedules deletion of anything', () => {
  const script = readFileSync(new URL('../account/bootstrap.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\b(delete|schedule-key-deletion|disable-key|disable-key-rotation|update-alias)\b/);
});
