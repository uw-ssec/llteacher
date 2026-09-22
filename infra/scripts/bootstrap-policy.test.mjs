import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
const files = ['pulumi-state-kms-key-policy.json', 'pulumi-state-bucket-policy.json', 'github-oidc-trust-policy.json', 'github-deploy-policy.template.json', 'github-compute-policy.json', 'github-data-policy.json'];
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

for (const file of files) {
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
    assert(['ManageLlteacherRoles', 'AttachLlteacherExecutionPolicy', 'PassLlteacherTaskRoles'].includes(s.Sid));
  }
  sameMembers(actions(statement('ManageLlteacherRoles')), [
    'iam:CreateRole', 'iam:GetRole', 'iam:DeleteRole', 'iam:TagRole', 'iam:UntagRole',
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

test('three focused deployment policies fit the AWS managed-policy size limit after substitution', () => {
  for (const file of files.slice(3)) {
    const rendered = JSON.parse(read(file).replace(kmsToken, `arn:aws:kms:${region}:${account}:key/12345678-1234-1234-1234-123456789abc`));
    assert(JSON.stringify(rendered).length < 6144, `${file} exceeds the managed-policy limit`);
  }
  assert(policy(files[3]).Statement.every(s => s.Sid.startsWith('PulumiState')));
  const computeServices = new Set(['ec2', 'elasticloadbalancing', 'ecs', 'ecr', 'logs']);
  assert(policy(files[4]).Statement.every(s => actions(s).every(a => computeServices.has(a.split(':')[0]))));
  const dataServices = new Set(['sts', 'rds', 's3', 'secretsmanager', 'acm', 'iam', 'route53']);
  assert(policy(files[5]).Statement.every(s => actions(s).every(a => dataServices.has(a.split(':')[0]))));
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
