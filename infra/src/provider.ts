import * as aws from "@pulumi/aws";
import type { InfraConfig } from "./config.js";

const flociServices: Array<keyof aws.types.input.ProviderEndpoint> = [
  "acm",
  "cloudwatchlogs",
  "ec2",
  "ecr",
  "ecs",
  "elbv2",
  "events",
  "iam",
  "rds",
  "s3",
  "secretsmanager",
];

/**
 * The only provider allowed to receive Floci endpoint overrides is the local
 * stack. The non-local stacks deliberately inherit AWS's normal endpoints.
 */
export function createAwsProvider(config: InfraConfig): aws.Provider {
  if (!config.isLocal) return new aws.Provider("aws", {});

  const endpoint = config.endpoints.floci!;
  const endpoints = Object.fromEntries(flociServices.map((service) => [service, endpoint]));
  return new aws.Provider("floci", {
    accessKey: "test",
    secretKey: "test",
    endpoints: [endpoints],
    region: "us-east-1",
    s3UsePathStyle: true,
    skipCredentialsValidation: true,
    skipMetadataApiCheck: true,
    skipRequestingAccountId: true,
  });
}
