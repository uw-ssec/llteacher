import * as aws from "@pulumi/aws";
import type { InfraConfig } from "./config.js";

const flociServices: Array<keyof aws.types.input.ProviderEndpoint> = [
  "acm",
  "cloudwatchlogs",
  "ec2",
  "ecr",
  "ecs",
  "elbv2",
  "iam",
  "rds",
  "route53",
  "s3",
  "secretsmanager",
];

/**
 * The only provider allowed to receive Floci endpoint overrides is the local
 * stack. The non-local stacks deliberately inherit AWS's normal endpoints.
 */
export function createAwsProvider(config: InfraConfig): aws.Provider {
  if (!config.isLocal) return new aws.Provider("aws", { region: config.region as aws.Region });

  const endpoint = config.endpoints.floci!;
  const endpoints = Object.fromEntries(flociServices.map((service) => [service, endpoint]));
  return new aws.Provider("floci", {
    accessKey: "test",
    secretKey: "test",
    endpoints: [endpoints],
    region: config.region as aws.Region,
    s3UsePathStyle: true,
    skipCredentialsValidation: true,
    skipMetadataApiCheck: true,
    skipRequestingAccountId: true,
  });
}

/** Keeps Floci's canonical-ECR compatibility quirk out of app resources. */
export function resolveApplicationImage(
  config: InfraConfig,
  name: string,
  repositoryUrl: string,
): string {
  const repository = config.isLocal
    ? `000000000000.dkr.ecr.${config.region}.amazonaws.com/${name}/app`
    : repositoryUrl;
  return config.imageDigest ? `${repository}@${config.imageDigest}` : `${repository}:${config.imageTag}`;
}
