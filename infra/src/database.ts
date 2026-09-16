import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { Network } from "./network.js";

export interface Database {
  databaseUrlSecret: aws.secretsmanager.Secret;
  databaseUrlSecretVersion: aws.secretsmanager.SecretVersion;
  instance: aws.rds.Instance;
  materialsBucket: aws.s3.Bucket;
}

export function createDataResources(name: string, network: Network, provider: aws.Provider): Database {
  const options = { provider };
  const subnetGroup = new aws.rds.SubnetGroup(`${name}-db-subnets`, {
    subnetIds: network.publicSubnetIds,
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
    publiclyAccessible: false,
    skipFinalSnapshot: true,
    storageEncrypted: true,
    username: "llteacher",
    vpcSecurityGroupIds: [network.databaseSecurityGroup.id],
  }, options);
  const databaseUrlSecret = new aws.secretsmanager.Secret(`${name}-database-url`, {
    description: "LLTeacher Postgres URL; pgvector is enabled by the migration bootstrap.",
  }, options);
  const databaseUrlSecretVersion = new aws.secretsmanager.SecretVersion(`${name}-database-url-value`, {
    secretId: databaseUrlSecret.id,
    secretString: pulumi.interpolate`postgres://llteacher:${password}@${instance.address}:${instance.port}/llteacher`,
  }, options);
  const materialsBucket = new aws.s3.Bucket(`${name}-materials`, {
    forceDestroy: false,
  }, options);
  new aws.s3.BucketPublicAccessBlock(`${name}-materials-private`, {
    blockPublicAcls: true,
    blockPublicPolicy: true,
    bucket: materialsBucket.id,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  }, options);
  return { databaseUrlSecret, databaseUrlSecretVersion, instance, materialsBucket };
}
