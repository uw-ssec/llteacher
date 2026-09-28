import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";
import type { Network } from "./network.js";

export interface Database {
  databaseUrlSecret: aws.secretsmanager.Secret;
  databaseUrlSecretVersion: aws.secretsmanager.SecretVersion;
  instance: aws.rds.Instance;
  materialsBucket: aws.s3.Bucket;
  runtimeSecret: aws.secretsmanager.Secret;
  runtimeSecretVersion: aws.secretsmanager.SecretVersion;
}

export function createDataResources(name: string, config: InfraConfig, network: Network, provider: aws.Provider): Database {
  const options = { provider };
  const subnetGroup = new aws.rds.SubnetGroup(`${name}-db-subnets`, {
    subnetIds: network.databaseSubnetIds,
  }, options);
  const password = new pulumi.Config().requireSecret("databasePassword");
  const instance = new aws.rds.Instance(`${name}-postgres`, {
    allocatedStorage: 20,
    dbName: "llteacher",
    dbSubnetGroupName: subnetGroup.name,
    engine: "postgres",
    engineVersion: "16",
    instanceClass: "db.t3.micro",
    password,
    backupRetentionPeriod: config.isLocal ? 0 : 7,
    copyTagsToSnapshot: !config.isLocal,
    deleteAutomatedBackups: config.isLocal,
    deletionProtection: !config.isLocal,
    finalSnapshotIdentifier: config.isLocal ? undefined : `${name}-postgres-final`,
    publiclyAccessible: false,
    skipFinalSnapshot: config.isLocal,
    storageEncrypted: true,
    username: "llteacher",
    vpcSecurityGroupIds: [network.databaseSecurityGroup.id],
  }, config.isLocal ? options : { ...options, protect: true });
  const databaseUrlSecret = new aws.secretsmanager.Secret(`${name}-database-url`, {
    description: "LLTeacher Postgres URL; pgvector is enabled by the migration bootstrap.",
  }, options);
  const encodedPassword = password.apply((value) => encodeURIComponent(value));
  const databaseUrlSecretVersion = new aws.secretsmanager.SecretVersion(`${name}-database-url-value`, {
    secretId: databaseUrlSecret.id,
    secretString: pulumi.interpolate`postgres://llteacher:${encodedPassword}@${instance.address}:${instance.port}/llteacher${config.isLocal ? "" : "?sslmode=verify-full"}`,
  }, options);
  const runtimeSecretValue = new pulumi.Config().requireSecret("runtimeSecrets");
  const runtimeSecret = new aws.secretsmanager.Secret(`${name}-runtime`, {
    description: "LLTeacher WorkOS, LLM provider, and application encryption settings.",
  }, options);
  const runtimeSecretVersion = new aws.secretsmanager.SecretVersion(`${name}-runtime-value`, {
    secretId: runtimeSecret.id,
    secretString: runtimeSecretValue!,
  }, options);
  const materialsBucket = new aws.s3.Bucket(`${name}-materials`, {
    forceDestroy: false,
    serverSideEncryptionConfiguration: { rule: { applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } } },
  }, { ...options, protect: !config.isLocal });
  const versioning = new aws.s3.BucketVersioningV2(`${name}-materials-versioning`, {
    bucket: materialsBucket.id,
    versioningConfiguration: { status: "Enabled" },
  }, options);
  new aws.s3.BucketLifecycleConfigurationV2(`${name}-materials-lifecycle`, {
    bucket: materialsBucket.id,
    rules: [{ id: "expire-noncurrent", status: "Enabled", noncurrentVersionExpiration: { noncurrentDays: 30 } }],
  }, { ...options, dependsOn: [versioning] });
  new aws.s3.BucketPublicAccessBlock(`${name}-materials-private`, {
    blockPublicAcls: true,
    blockPublicPolicy: true,
    bucket: materialsBucket.id,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  }, options);
  return { databaseUrlSecret, databaseUrlSecretVersion, instance, materialsBucket, runtimeSecret, runtimeSecretVersion };
}
