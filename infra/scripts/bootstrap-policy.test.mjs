import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('bootstrap guide covers fail-closed identity, policy and boundary checks without inline deploy policies', () => {
  const guide = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const bootstrap = guide.split('### One-time account/stack bootstrap')[1]?.split('### Rollback and rotation')[0];
  assert(bootstrap, 'bootstrap procedure exists');
  for (const command of ['umask 077', 'mktemp -d', 'get-caller-identity --profile default',
    'get-key-rotation-status', 'get-bucket-ownership-controls', 'get-public-access-block',
    'get-bucket-versioning', 'get-bucket-encryption', 'get-bucket-policy', 'get-bucket-tagging',
    'get-bucket-lifecycle-configuration', 'get-open-id-connect-provider', 'list-roles',
    'PermissionsBoundary.PermissionsBoundaryArn', 'create-policy-version', 'list-attached-role-policies',
    'github-compute-policy.json', 'github-data-policy.json', 'github-network-policy.json', 'runtime-permissions-boundary.json',
    'LLTeacherStack=production', 'describe-vpcs', 'describe-internet-gateways', 'describe-route-tables',
    'describe-subnets', 'describe-security-groups', 'list-tags-for-certificate',
    'llteacher-production-runtime-boundary', 'jq --arg',
    'awskms://alias/llteacher-pulumi-state?region=us-west-2&awssdk=v2']) {
    assert(bootstrap.includes(command), `missing bootstrap safeguard: ${command}`);
  }
  assert.doesNotMatch(bootstrap, /put-role-policy|pulumi[^\n]*\bup\b|--show-secrets|--debug/);
  assert.match(bootstrap, /privileged migration\/replacement/);
  assert.match(bootstrap, /No Pulumi access token is used/);
  assert.match(bootstrap, /Read-only check[\s\S]*Mutation[\s\S]*Verification/);
  for (const [, shell] of bootstrap.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const parsed = spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test('bootstrap inventory, creation and attachment verification cover four deployment policies and a separate boundary', () => {
  const guide = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const grants = ['state', 'compute', 'data', 'network'].map(name => `llteacher-production-deploy-${name}`);
  const managed = ['llteacher-production-runtime-boundary', ...grants];
  assert(guide.includes(`POLICY_NAMES=(${managed.join(' ')})`));
  assert(guide.includes(`for policy_name in ${managed.join(' ')}; do`), 'inventory includes every policy');
  assert(guide.includes(`for policy_name in ${grants.join(' ')}; do`), 'attach only the four deployment grants');
  assert(guide.includes('for index in 1 2 3 4; do'), 'verify all four attachments');
  assert(guide.includes('[$prefix + "state", $prefix + "compute", $prefix + "data", $prefix + "network"]'));
  assert.match(guide, /four deployment policies/);
  assert.match(guide, /all five managed policies/);
});

test('persisted KMS provider URLs allow OIDC credentials without requiring a local shared profile', () => {
  for (const path of ['../README.md', '../../docs/superpowers/plans/2026-09-22-s3-pulumi-backend-implementation.md']) {
    const document = readFileSync(new URL(path, import.meta.url), 'utf8');
    const providers = [...document.matchAll(/awskms:\/\/[^\s'"`]+/g)].map(match => new URL(match[0]));
    assert(providers.length > 0, `${path}: missing KMS provider URL`);
    for (const provider of providers) {
      assert.equal(provider.searchParams.has('profile'), false, `${path}: persisted profile overrides OIDC credentials`);
      assert.equal(provider.href, 'awskms://alias/llteacher-pulumi-state?region=us-west-2&awssdk=v2');
    }
  }
  const guide = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(guide, /export AWS_PROFILE=default AWS_REGION=us-west-2/);
});

const account = '055237683908';
const region = 'us-west-2';
const bucket = 'llteacher-pulumi-state-055237683908-us-west-2';
const prefix = 'llteacher-infra/.pulumi/';
const oidcProvider = `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
const deployRole = `arn:aws:iam::${account}:role/llteacher-production-deploy`;
const runtimeRoles = [
  `arn:aws:iam::${account}:role/llteacher-production-execution-role-*`,
  `arn:aws:iam::${account}:role/llteacher-production-task-role-*`,
];
const bucketArn = `arn:aws:s3:::${bucket}`;
const kmsToken = '${KMS_KEY_ARN}';
const boundaryFile = 'runtime-permissions-boundary.json';
const boundaryArn = `arn:aws:iam::${account}:policy/llteacher-production-runtime-boundary`;
const files = ['pulumi-state-kms-key-policy.json', 'pulumi-state-bucket-policy.json', 'github-oidc-trust-policy.json', 'github-deploy-policy.template.json', 'github-compute-policy.json', 'github-data-policy.json', 'github-network-policy.json'];
const read = name => readFileSync(new URL(`../bootstrap/${name}`, import.meta.url), 'utf8');
const policy = name => JSON.parse(read(name));
const deploy = () => files.slice(3).flatMap(file => policy(file).Statement);
const array = value => Array.isArray(value) ? value : [value];
const actions = statement => array(statement.Action);
const resources = statement => array(statement.Resource);
const withAction = (statements, action) => statements.filter(s => actions(s).includes(action));
function statement(sid) {
  const matches = deploy().filter(s => s.Sid === sid);
  assert.equal(matches.length, 1, `exactly one ${sid} statement`);
  return matches[0];
}
function sameMembers(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

// Evaluate only the literal IAM operators used in the ownership policies.
// This exercises deny cases in the real documents, not an AWS simulator.
function globMatches(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`).test(value);
}
function policyAllows(action, resource, context = {}) {
  return deploy().some(s => s.Effect === 'Allow'
    && actions(s).some(a => globMatches(a, action))
    && resources(s).some(r => globMatches(r, resource))
    && Object.entries(s.Condition ?? {}).every(([operator, entries]) => Object.entries(entries).every(([key, expected]) => {
      const actual = context[key];
      if (operator === 'StringEquals' || operator === 'ArnEquals') return actual !== undefined && array(expected).includes(actual);
      if (operator === 'StringEqualsIfExists') return actual === undefined || array(expected).includes(actual);
      if (operator === 'Null') return (actual === undefined) === (expected === 'true');
      if (operator === 'ForAllValues:StringNotEquals') return array(actual ?? []).every(v => !array(expected).includes(v));
      assert.fail(`Unsupported ownership-test operator: ${operator}`);
    })));
}

test('EC2 mutations reject unrelated and untagged VPCs, routes, subnets and security groups', () => {
  const cases = [
    ['ec2:ModifyVpcAttribute', 'vpc/vpc-test'], ['ec2:DeleteVpc', 'vpc/vpc-test'],
    ['ec2:CreateRoute', 'route-table/rtb-test'], ['ec2:ReplaceRoute', 'route-table/rtb-test'],
    ['ec2:DeleteRoute', 'route-table/rtb-test'], ['ec2:DeleteRouteTable', 'route-table/rtb-test'],
    ['ec2:AssociateRouteTable', 'subnet/subnet-test'], ['ec2:DisassociateRouteTable', 'route-table/rtb-test'],
    ['ec2:ModifySubnetAttribute', 'subnet/subnet-test'], ['ec2:DeleteSubnet', 'subnet/subnet-test'],
    ['ec2:AuthorizeSecurityGroupIngress', 'security-group/sg-test'], ['ec2:AuthorizeSecurityGroupEgress', 'security-group/sg-test'],
    ['ec2:RevokeSecurityGroupIngress', 'security-group/sg-test'], ['ec2:RevokeSecurityGroupEgress', 'security-group/sg-test'],
    ['ec2:DeleteSecurityGroup', 'security-group/sg-test'], ['ec2:AttachInternetGateway', 'vpc/vpc-test'],
    ['ec2:DetachInternetGateway', 'internet-gateway/igw-test'], ['ec2:DeleteInternetGateway', 'internet-gateway/igw-test'],
  ];
  for (const [action, suffix] of cases) {
    const resource = `arn:aws:ec2:${region}:${account}:${suffix}`;
    for (const owner of [undefined, 'unrelated', 'staging']) {
      assert.equal(policyAllows(action, resource, { 'aws:RequestedRegion': region, 'aws:ResourceTag/LLTeacherStack': owner }), false, `${action} ${owner}`);
    }
    assert(policyAllows(action, resource, { 'aws:RequestedRegion': region, 'aws:ResourceTag/LLTeacherStack': 'production' }), action);
    assert.equal(policyAllows(action, resource.replace(account, '111111111111'), { 'aws:RequestedRegion': region, 'aws:ResourceTag/LLTeacherStack': 'production' }), false, `${action} wrong account`);
    assert.equal(policyAllows(action, resource, { 'aws:RequestedRegion': 'us-east-1', 'aws:ResourceTag/LLTeacherStack': 'production' }), false, `${action} wrong region`);
  }
});

test('EC2 creates require ownership request tags and owned parent VPCs', () => {
  const creates = [
    ['ec2:CreateVpc', 'vpc/vpc-new'], ['ec2:CreateInternetGateway', 'internet-gateway/igw-new'],
    ['ec2:CreateRouteTable', 'route-table/rtb-new'], ['ec2:CreateSubnet', 'subnet/subnet-new'],
    ['ec2:CreateSecurityGroup', 'security-group/sg-new'],
  ];
  for (const [action, suffix] of creates) {
    const resource = `arn:aws:ec2:${region}:${account}:${suffix}`;
    assert(policyAllows(action, resource, { 'aws:RequestedRegion': region, 'aws:RequestTag/LLTeacherStack': 'production' }), action);
    for (const owner of [undefined, 'unrelated']) assert.equal(policyAllows(action, resource, { 'aws:RequestedRegion': region, 'aws:RequestTag/LLTeacherStack': owner }), false, action);
  }
  for (const action of ['ec2:CreateRouteTable', 'ec2:CreateSubnet', 'ec2:CreateSecurityGroup']) {
    const vpc = `arn:aws:ec2:${region}:${account}:vpc/vpc-parent`;
    assert(policyAllows(action, vpc, { 'aws:RequestedRegion': region, 'aws:ResourceTag/LLTeacherStack': 'production' }), action);
    // New-resource request tags must never authorize a different parent VPC.
    assert.equal(policyAllows(action, vpc, { 'aws:RequestedRegion': region, 'aws:RequestTag/LLTeacherStack': 'production', 'aws:ResourceTag/LLTeacherStack': 'unrelated' }), false, action);
  }
});

test('EC2 tagging can neither claim unrelated resources nor change or remove ownership', () => {
  for (const [kind, createAction] of [
    ['vpc/vpc-test', 'CreateVpc'], ['internet-gateway/igw-test', 'CreateInternetGateway'],
    ['route-table/rtb-test', 'CreateRouteTable'], ['subnet/subnet-test', 'CreateSubnet'],
    ['security-group/sg-test', 'CreateSecurityGroup'],
  ]) {
    const resource = `arn:aws:ec2:${region}:${account}:${kind}`;
    const request = { 'aws:RequestedRegion': region, 'aws:TagKeys': ['LLTeacherStack'], 'aws:RequestTag/LLTeacherStack': 'production' };
    assert(policyAllows('ec2:CreateTags', resource, { ...request, 'ec2:CreateAction': createAction }));
    assert.equal(policyAllows('ec2:CreateTags', resource, request), false);
    assert.equal(policyAllows('ec2:CreateTags', resource, { ...request, 'aws:ResourceTag/LLTeacherStack': 'unrelated' }), false);
    for (const action of ['ec2:CreateTags', 'ec2:DeleteTags']) {
      const owned = { ...request, 'aws:ResourceTag/LLTeacherStack': 'production' };
      assert.equal(policyAllows(action, resource, owned), false, action);
      assert(policyAllows(action, resource, { ...owned, 'aws:TagKeys': ['Name'] }), action);
      // DeleteTags with no tag list deletes all user tags; a vacuous set match
      // must not permit it to strip the ownership tag.
      assert.equal(policyAllows(action, resource, { ...owned, 'aws:TagKeys': undefined }), false, `${action} missing tag keys`);
    }
  }
});

test('ACM issuance requires ownership and existing certificates cannot be claimed or stripped of ownership', () => {
  const cert = `arn:aws:acm:${region}:${account}:certificate/test`;
  const regional = { 'aws:RequestedRegion': region };
  assert(policyAllows('acm:RequestCertificate', '*', { ...regional, 'aws:RequestTag/LLTeacherStack': 'production' }));
  assert.equal(policyAllows('acm:RequestCertificate', '*', regional), false);
  for (const action of ['acm:DeleteCertificate', 'acm:AddTagsToCertificate', 'acm:RemoveTagsFromCertificate']) {
    for (const owner of [undefined, 'unrelated']) {
      assert.equal(policyAllows(action, cert, { ...regional, 'aws:ResourceTag/LLTeacherStack': owner, 'aws:RequestTag/LLTeacherStack': 'production', 'aws:TagKeys': ['LLTeacherStack'] }), false, `${action} ${owner}`);
    }
    assert(policyAllows(action, cert, { ...regional, 'aws:ResourceTag/LLTeacherStack': 'production', 'aws:TagKeys': ['Name'] }), action);
  }
  assert.equal(policyAllows('acm:AddTagsToCertificate', cert, { ...regional, 'aws:ResourceTag/LLTeacherStack': 'production', 'aws:RequestTag/LLTeacherStack': 'unrelated', 'aws:TagKeys': ['LLTeacherStack'] }), false);
  assert.equal(policyAllows('acm:RemoveTagsFromCertificate', cert, { ...regional, 'aws:ResourceTag/LLTeacherStack': 'production', 'aws:TagKeys': ['LLTeacherStack'] }), false);
  // Provider deletion polling must be able to observe an absent certificate;
  // no resource tags exist after deletion, so reads cannot depend on them.
  assert(policyAllows('acm:DescribeCertificate', cert, regional));
});

for (const file of [...files, boundaryFile]) {
  test(`${file} is a complete policy document`, () => {
    const document = policy(file);
    assert.equal(document.Version, '2012-10-17');
    assert(document.Statement.length > 0);
    assert.equal(new Set(document.Statement.map(s => s.Sid)).size, document.Statement.length);
    for (const s of document.Statement) {
      assert.equal('NotAction' in s, false);
      assert.equal('NotResource' in s, false);
      assert.equal('NotPrincipal' in s, false);
    }
  });
}

test('KMS delegates only to this account IAM policies', () => {
  assert.deepEqual(policy(files[0]).Statement, [{
    Sid: 'EnableAccountIAMPolicies', Effect: 'Allow',
    Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'kms:*', Resource: '*',
  }]);
});

test('state bucket policy only denies insecure bucket and object requests', () => {
  assert.deepEqual(policy(files[1]).Statement, [{
    Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*',
    Resource: [bucketArn, `${bucketArn}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  }]);
});

test('OIDC trust admits only the production environment with the STS audience', () => {
  const statements = policy(files[2]).Statement;
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0], {
    Sid: 'GitHubProductionEnvironment', Effect: 'Allow', Principal: { Federated: oidcProvider },
    Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:uw-ssec/llteacher:environment:production',
    } },
  });
});

test('state list and object permissions cannot escape the backend prefix', () => {
  const list = statement('PulumiStateList');
  sameMembers(actions(list), ['s3:ListBucket']);
  assert.deepEqual(resources(list), [bucketArn]);
  assert.deepEqual(list.Condition, { StringLike: { 's3:prefix': [prefix.slice(0, -1), `${prefix}*`] } });
  const location = statement('PulumiStateLocation');
  assert.deepEqual(actions(location), ['s3:GetBucketLocation']);
  assert.deepEqual(resources(location), [bucketArn]);
  assert.equal(location.Condition, undefined);
  const objects = statement('PulumiStateObjects');
  sameMembers(actions(objects), ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject']);
  assert.deepEqual(resources(objects), [`${bucketArn}/${prefix}*`]);
  for (const s of deploy().filter(s => actions(s).some(a => a.startsWith('s3:')))) {
    assert(['PulumiStateList', 'PulumiStateLocation', 'PulumiStateObjects', 'ApplicationS3', 'ApplicationS3Create'].includes(s.Sid));
  }
});

test('KMS template has one substitution and grants crypto operations only', () => {
  assert.equal(read(files[3]).split(kmsToken).length - 1, 1);
  const kms = deploy().filter(s => actions(s).some(a => a.startsWith('kms:')));
  assert.equal(kms.length, 1);
  assert.equal(kms[0].Sid, 'PulumiStateKms');
  assert.deepEqual(resources(kms[0]), [kmsToken]);
  sameMembers(actions(kms[0]), ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey']);
});

test('deployment grants no administrator wildcard, KMS administration, or OIDC trust management', () => {
  for (const s of deploy()) {
    assert.equal(s.Effect, 'Allow');
    assert.equal('Principal' in s, false);
    for (const action of actions(s)) {
      assert(!['*', 'iam:*', 's3:*', 'kms:*', 'kms:PutKeyPolicy', 'kms:DisableKey', 'kms:ScheduleKeyDeletion', 'iam:UpdateAssumeRolePolicy'].includes(action), `${s.Sid}: ${action}`);
      assert(!action.toLowerCase().includes('openidconnectprovider'), action);
    }
  }
  for (const file of files.slice(3)) assert(!read(file).includes('AdministratorAccess'));
});

test('IAM lifecycle and ECS pass-role access cover only runtime roles, excluding the deploy role', () => {
  for (const s of deploy().filter(s => actions(s).some(a => a.startsWith('iam:')))) {
    sameMembers(resources(s), runtimeRoles);
    for (const resource of resources(s)) assert(!deployRole.startsWith(resource.slice(0, -1)));
    assert(['CreateLlteacherRoles', 'ManageLlteacherRoles', 'AttachLlteacherExecutionPolicy', 'PassLlteacherTaskRoles'].includes(s.Sid));
  }
  sameMembers(actions(statement('ManageLlteacherRoles')), [
    'iam:GetRole', 'iam:DeleteRole', 'iam:TagRole', 'iam:UntagRole',
    'iam:ListRoleTags', 'iam:ListRolePolicies', 'iam:GetRolePolicy', 'iam:PutRolePolicy',
    'iam:DeleteRolePolicy', 'iam:ListAttachedRolePolicies',
  ]);
  const pass = statement('PassLlteacherTaskRoles');
  assert.deepEqual(actions(pass), ['iam:PassRole']);
  assert.deepEqual(pass.Condition, { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
  assert.equal(withAction(deploy(), 'iam:PassRole').length, 1);
  const attach = statement('AttachLlteacherExecutionPolicy');
  sameMembers(actions(attach), ['iam:AttachRolePolicy', 'iam:DetachRolePolicy']);
  assert.deepEqual(attach.Condition, { ArnEquals: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy' } });
});

test('runtime role creation requires the fixed boundary and deployment cannot change boundaries', () => {
  const create = statement('CreateLlteacherRoles');
  assert.deepEqual(actions(create), ['iam:CreateRole']);
  sameMembers(resources(create), runtimeRoles);
  assert.deepEqual(create.Condition, { ArnEquals: { 'iam:PermissionsBoundary': boundaryArn } });
  assert.equal(withAction(deploy(), 'iam:CreateRole').length, 1);
  const forbidden = ['iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary',
    'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'];
  for (const s of deploy()) {
    assert(actions(s).every(a => !forbidden.includes(a)), s.Sid);
    assert(!resources(s).includes(boundaryArn), s.Sid);
  }
});

test('ECR provider refresh can read tags only on the production repository', () => {
  const readers = withAction(deploy(), 'ecr:ListTagsForResource');
  assert.equal(readers.length, 1);
  assert.equal(readers[0].Sid, 'EcrRepository');
  assert.deepEqual(resources(readers[0]), [`arn:aws:ecr:${region}:${account}:repository/llteacher-production/app`]);
});

test('runtime boundary permits only image pulls, app log writes, app secret reads and course storage', () => {
  const boundary = policy(boundaryFile);
  assert(JSON.stringify(boundary).length < 6144);
  const regional = { StringEquals: { 'aws:RequestedRegion': region } };
  assert.deepEqual(boundary.Statement, [
    { Sid: 'EcrAuthorization', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*', Condition: regional },
    { Sid: 'PullApplicationImage', Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], Resource: `arn:aws:ecr:${region}:${account}:repository/llteacher-production/app`, Condition: regional },
    { Sid: 'WriteApplicationLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${region}:${account}:log-group:llteacher-production-app-logs-*:log-stream:*`, Condition: regional },
    { Sid: 'ReadApplicationSecrets', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: [
      `arn:aws:secretsmanager:${region}:${account}:secret:llteacher-production-database-url-*`,
      `arn:aws:secretsmanager:${region}:${account}:secret:llteacher-production-runtime-*`,
    ], Condition: regional },
    { Sid: 'ListCourseStorage', Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::llteacher-production-materials-*', Condition: { StringLike: { 's3:prefix': ['courses/*/materials/*', 'courses/*/knowledge/*'] } } },
    { Sid: 'ReadWriteCourseStorage', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [
      'arn:aws:s3:::llteacher-production-materials-*/courses/*/materials/*',
      'arn:aws:s3:::llteacher-production-materials-*/courses/*/knowledge/*',
    ] },
  ]);
  for (const s of boundary.Statement) {
    assert(actions(s).every(a => !a.startsWith('kms:') && !a.startsWith('iam:') && !a.startsWith('sts:')));
    assert(resources(s).every(r => !r.includes(bucket) && !r.includes('.pulumi')));
    if (resources(s).includes('*')) assert.deepEqual(actions(s), ['ecr:GetAuthorizationToken']);
  }
});

test('four focused deployment policies fit the AWS managed-policy size limit after substitution', () => {
  for (const file of files.slice(3)) {
    const rendered = JSON.parse(read(file).replace(kmsToken, `arn:aws:kms:${region}:${account}:key/12345678-1234-1234-1234-123456789abc`));
    assert(JSON.stringify(rendered).length < 6144, `${file} exceeds the managed-policy limit`);
  }
  assert(policy(files[3]).Statement.every(s => s.Sid.startsWith('PulumiState')));
  const computeServices = new Set(['elasticloadbalancing', 'ecs', 'ecr', 'logs']);
  assert(policy(files[4]).Statement.every(s => actions(s).every(a => computeServices.has(a.split(':')[0]))));
  const dataServices = new Set(['sts', 'rds', 's3', 'secretsmanager', 'acm', 'iam', 'route53']);
  assert(policy(files[5]).Statement.every(s => actions(s).every(a => dataServices.has(a.split(':')[0]))));
  assert(policy(files[6]).Statement.every(s => actions(s).every(a => a.startsWith('ec2:'))));
});

test('regional services require us-west-2 and global IAM and DNS stay separate', () => {
  const regional = new Set(['ec2', 'elasticloadbalancing', 'ecs', 'ecr', 'rds', 'secretsmanager', 'logs', 'acm']);
  for (const s of deploy()) {
    const services = [...new Set(actions(s).map(a => a.split(':')[0]))];
    assert.equal(services.length, 1, `${s.Sid} mixes services`);
    if (regional.has(services[0])) assert.equal(s.Condition?.StringEquals?.['aws:RequestedRegion'], region, s.Sid);
    if (['iam', 'route53'].includes(services[0])) assert.equal(JSON.stringify(s.Condition ?? {}).includes('aws:RequestedRegion'), false);
  }
});

test('application S3 grants cannot administer the backend bucket and creation pins location', () => {
  const app = statement('ApplicationS3');
  sameMembers(resources(app), ['arn:aws:s3:::llteacher-production-*', 'arn:aws:s3:::llteacher-production-*/*']);
  assert(!actions(app).includes('s3:CreateBucket'));
  const create = statement('ApplicationS3Create');
  assert.deepEqual(actions(create), ['s3:CreateBucket']);
  assert.deepEqual(resources(create), ['arn:aws:s3:::llteacher-production-*']);
  assert.deepEqual(create.Condition, { StringEquals: { 's3:LocationConstraint': region } });
  sameMembers(actions(app), [
    's3:DeleteBucket', 's3:ListBucket', 's3:GetBucket*', 's3:GetEncryptionConfiguration',
    's3:GetLifecycleConfiguration', 's3:GetReplicationConfiguration', 's3:GetAccelerateConfiguration',
    's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock',
    's3:PutLifecycleConfiguration', 's3:PutBucketTagging',
  ]);
});

test('repository, secrets, logs, load balancer and ECS writes target production resources', () => {
  assert.deepEqual(resources(statement('EcrRepository')), [`arn:aws:ecr:${region}:${account}:repository/llteacher-production/app`]);
  assert.deepEqual(resources(statement('SecretsManager')), [`arn:aws:secretsmanager:${region}:${account}:secret:llteacher-production-*`]);
  for (const sid of ['CloudWatchLogs', 'ElasticLoadBalancing', 'Ecs', 'Rds', 'Acm']) {
    for (const resource of resources(statement(sid))) {
      assert(resource.startsWith('arn:aws:'), `${sid}: ${resource}`);
      assert(resource.includes(`:${region}:${account}:`), `${sid}: ${resource}`);
      if (sid !== 'Acm') assert(/llteacher-production-|targetgroup\/llt-production-app\//.test(resource), `${sid}: ${resource}`);
      if (sid === 'CloudWatchLogs') assert(resource.includes(':log-group:llteacher-production-app-logs-*'));
    }
  }
});

test('CloudWatch log group lifecycle and tagging cover the actual Pulumi name and ARN forms', () => {
  sameMembers(resources(statement('CloudWatchLogs')), [
    `arn:aws:logs:${region}:${account}:log-group:llteacher-production-app-logs-*`,
    `arn:aws:logs:${region}:${account}:log-group:llteacher-production-app-logs-*:*`,
  ]);
  assert.deepEqual(actions(statement('CloudWatchLogsDiscovery')), ['logs:DescribeLogGroups']);
  assert.deepEqual(resources(statement('CloudWatchLogsDiscovery')), ['*']);
});

test('ECS discovery uses supported IAM scopes and list calls require the production cluster', () => {
  sameMembers(actions(statement('EcsDiscovery')), ['ecs:ListClusters', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition']);
  assert.deepEqual(resources(statement('EcsDiscovery')), ['*']);
  const list = statement('EcsClusterDiscovery');
  sameMembers(actions(list), ['ecs:ListServices', 'ecs:ListTasks']);
  assert.deepEqual(resources(list), ['*']);
  assert.deepEqual(list.Condition, {
    StringEquals: { 'aws:RequestedRegion': region },
    ArnEquals: { 'ecs:cluster': `arn:aws:ecs:${region}:${account}:cluster/llteacher-production-cluster` },
  });
  for (const a of ['ecs:ListServices', 'ecs:ListTasks', 'ecs:DescribeTaskDefinition']) {
    assert.equal(withAction(deploy(), a).length, 1);
  }
});

test('provider refresh can read only production secrets', () => {
  const readers = withAction(deploy(), 'secretsmanager:GetSecretValue');
  assert.equal(readers.length, 1);
  assert.deepEqual(resources(readers[0]), [`arn:aws:secretsmanager:${region}:${account}:secret:llteacher-production-*`]);
});

test('RDS may use PostgreSQL 16 default groups during creation without modifying them', () => {
  const defaults = statement('RdsPostgresDefaults');
  assert.deepEqual(actions(defaults), ['rds:CreateDBInstance']);
  sameMembers(resources(defaults), [
    `arn:aws:rds:${region}:${account}:pg:default.postgres16`,
    `arn:aws:rds:${region}:${account}:og:default:postgres-16`,
  ]);
  assert.deepEqual(defaults.Condition, { StringEquals: { 'aws:RequestedRegion': region } });
  for (const s of deploy().filter(s => resources(s).some(r => r.includes(':default')))) {
    assert.equal(s.Sid, 'RdsPostgresDefaults');
  }
});

test('Route 53 permissions contain only required zone and record lifecycle operations', () => {
  const route = deploy().filter(s => actions(s).some(a => a.startsWith('route53:')));
  sameMembers(route.flatMap(actions), [
    'route53:CreateHostedZone', 'route53:ListHostedZones', 'route53:ListHostedZonesByName',
    'route53:GetHostedZone', 'route53:DeleteHostedZone', 'route53:UpdateHostedZoneComment',
    'route53:ListResourceRecordSets', 'route53:ChangeResourceRecordSets',
    'route53:ListTagsForResource', 'route53:ChangeTagsForResource', 'route53:GetChange',
  ]);
  assert.deepEqual(resources(statement('ManageLlteacherRoute53')), ['arn:aws:route53:::hostedzone/*']);
  assert.deepEqual(resources(statement('Route53Changes')), ['arn:aws:route53:::change/*']);
  sameMembers(actions(statement('Route53Discovery')), ['route53:CreateHostedZone', 'route53:ListHostedZones', 'route53:ListHostedZonesByName']);
});
