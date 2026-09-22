import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";
import type { InfraConfig } from "./config.js";
import { createDataResources } from "./database.js";
import { createNetwork, type Network } from "./network.js";
import { createAwsProvider } from "./provider.js";

type RecordedResource = {
  name: string;
  type: string;
  inputs: Record<string, unknown>;
};

const resources: RecordedResource[] = [];

beforeAll(() => {
  pulumi.runtime.setMocks({
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push({ name: args.name, type: args.type, inputs: args.inputs });
      const state: Record<string, unknown> = {
        ...args.inputs,
        arn: `arn:aws:test:us-east-1:000000000000:${args.name}`,
        id: `${args.name}-id`,
        name: args.inputs.name ?? args.name,
      };
      if (args.type === "aws:ecr/repository:Repository") {
        state.repositoryUrl = `000000000000.dkr.ecr.us-east-1.amazonaws.com/${args.inputs.name}`;
      }
      if (args.type === "aws:rds/instance:Instance") {
        state.address = `${args.name}.database.test`;
        state.port = 5432;
      }
      if (args.type === "aws:lb/loadBalancer:LoadBalancer") {
        state.dnsName = `${args.name}.elb.test`;
        state.zoneId = "ZALB";
      }
      if (args.type === "aws:route53/zone:Zone") state.zoneId = `${args.name}-id`;
      if (args.type === "aws:s3/bucket:Bucket") state.bucket = `${args.name}-bucket`;
      if (args.type === "aws:acm/certificate:Certificate") {
        state.domainValidationOptions = [{
          domainName: args.inputs.domainName,
          resourceRecordName: `_validation.${args.inputs.domainName}`,
          resourceRecordType: "CNAME",
          resourceRecordValue: "validation.acm.test",
        }];
      }
      return { id: `${args.name}-id`, state };
    },
  }, "llteacher-infra", "test");
  pulumi.runtime.setAllConfig({
    "llteacher-infra:databasePassword": "database/pass",
    "llteacher-infra:runtimeSecrets": JSON.stringify({
      WORKOS_API_KEY: "workos-api-key",
      WORKOS_CLIENT_ID: "workos-client-id",
      OPENROUTER_API_KEY: "openrouter-api-key",
      LLMOXIE_API_KEY: "llmoxie-api-key",
      SESSION_SECRET: "session-secret",
      ENCRYPTION_KEY: "encryption-key",
      BLIND_INDEX_KEY: "blind-index-key",
      WORKOS_WEBHOOK_SECRET: "webhook-secret",
    }),
  }, ["llteacher-infra:databasePassword", "llteacher-infra:runtimeSecrets"]);
});

const productionConfig = {
  environment: "production",
  isLocal: false,
  domainName: "llteacher.example.edu",
  domainReady: true,
  region: "us-west-2",
  deployApp: true,
  provisionService: true,
  imageTag: "sha-123",
  endpoints: {},
} satisfies InfraConfig;

async function createProductionGraph() {
  const provider = createAwsProvider(productionConfig);
  const network = (createNetwork as unknown as (
    name: string,
    provider: aws.Provider,
    config: InfraConfig,
  ) => Network)("llteacher-production", provider, productionConfig);
  const data = createDataResources("llteacher-production", productionConfig, network, provider);
  const app = createApplication("llteacher-production", productionConfig, network, data, provider);
  const localConfig = { ...productionConfig, environment: "local", isLocal: true, endpoints: { floci: "http://localhost:4566" } } as const;
  const localProvider = createAwsProvider(localConfig);
  const localNetwork = createNetwork("llteacher-local", localProvider, localConfig);
  const localData = createDataResources("llteacher-local", localConfig, localNetwork, localProvider);
  createApplication("llteacher-local", localConfig, localNetwork, localData, localProvider);
  const pendingConfig = { ...productionConfig, domainReady: false, serviceTaskDefinition: "arn:previous-task" };
  const pendingNetwork = createNetwork("pending", provider, pendingConfig);
  const pendingData = createDataResources("pending", pendingConfig, pendingNetwork, provider);
  createApplication("pending", pendingConfig, pendingNetwork, pendingData, provider);
  const bootstrapConfig = { ...productionConfig, domainReady: false, domainName: undefined, provisionService: false, deployApp: false };
  const bootstrapNetwork = createNetwork("bootstrap", provider, bootstrapConfig);
  const bootstrapData = createDataResources("bootstrap", bootstrapConfig, bootstrapNetwork, provider);
  createApplication("bootstrap", bootstrapConfig, bootstrapNetwork, bootstrapData, provider);
  await pulumi.runtime.disconnect();
  return { app, data, network };
}

beforeAll(async () => {
  await createProductionGraph();
});

function resource(type: string, name: string): RecordedResource {
  const match = resources.find((candidate) => candidate.type === type && candidate.name === name);
  if (!match) throw new Error(`Missing ${type} resource ${name}`);
  return match;
}

describe("production resource graph", () => {
  it("validates the ACM certificate through Route 53 before creating the listener", async () => {
    expect(resources.some(({ type }) => type === "aws:route53/record:Record")).toBe(true);
    expect(resources.some(({ type }) => type === "aws:acm/certificateValidation:CertificateValidation")).toBe(true);
    expect(resource("aws:route53/record:Record", "llteacher-production-app-alias").inputs).toMatchObject({ type: "A", zoneId: "llteacher-production-zone-id", aliases: [{ name: "llteacher-production-alb.elb.test", zoneId: "ZALB", evaluateTargetHealth: true }] });
    expect(resource("aws:lb/listener:Listener", "llteacher-production-listener").inputs).toMatchObject({ port: 443, protocol: "HTTPS" });
  });

  it("allows first DNS delegation without waiting on certificate validation and preserves the serving task", () => {
    expect(resources.filter(({ name, type }) => name.startsWith("pending") && type === "aws:acm/certificateValidation:CertificateValidation")).toEqual([]);
    expect(resource("aws:route53/zone:Zone", "pending-zone")).toBeDefined();
    expect(resource("aws:lb/listener:Listener", "pending-listener").inputs).toMatchObject({ port: 80, protocol: "HTTP" });
    expect(resource("aws:ecs/service:Service", "pending-app-service").inputs).toMatchObject({ desiredCount: 1, taskDefinition: "arn:previous-task" });
  });

  it("bootstraps an ALB and candidate without starting an unavailable image", () => {
    expect(resources.filter(({ name, type }) => name.startsWith("bootstrap") && ["aws:ecs/service:Service", "aws:route53/zone:Zone", "aws:acm/certificate:Certificate"].includes(type))).toEqual([]);
    const [container] = JSON.parse(String(resource("aws:ecs/taskDefinition:TaskDefinition", "bootstrap-app-task").inputs.containerDefinitions));
    expect(container.environment).toContainEqual({ name: "APP_URL", value: "http://bootstrap-alb.elb.test" });
  });

  it("routes all local DNS API calls to Floci", () => {
    expect(JSON.parse(String(resource("pulumi:providers:aws", "floci").inputs.endpoints))).toContainEqual(expect.objectContaining({ route53: "http://localhost:4566" }));
  });

  it("places public application tasks behind the ALB and keeps the database private", async () => {
    const publicSubnets = resources.filter(({ name, type, inputs }) => name.startsWith("llteacher-production") && type === "aws:ec2/subnet:Subnet" && inputs.mapPublicIpOnLaunch === true);
    const privateSubnets = resources.filter(({ name, type, inputs }) => name.startsWith("llteacher-production") && type === "aws:ec2/subnet:Subnet" && inputs.mapPublicIpOnLaunch === false);
    expect(publicSubnets).toHaveLength(2);
    expect(privateSubnets).toHaveLength(2);

    const dbSubnetGroup = resource("aws:rds/subnetGroup:SubnetGroup", "llteacher-production-db-subnets");
    const service = resource("aws:ecs/service:Service", "llteacher-production-app-service");
    expect(dbSubnetGroup.inputs.subnetIds).toEqual(privateSubnets.map(({ name }) => `${name}-id`));
    expect(service.inputs.networkConfiguration).toMatchObject({
      assignPublicIp: true,
      subnets: publicSubnets.map(({ name }) => `${name}-id`),
    });
  });

  it("enables production RDS backups and deletion protection", async () => {
    expect(resource("aws:rds/instance:Instance", "llteacher-production-postgres").inputs).toMatchObject({
      backupRetentionPeriod: 7,
      deleteAutomatedBackups: false,
      deletionProtection: true,
      publiclyAccessible: false,
      skipFinalSnapshot: false,
    });
  });

  it("percent-encodes the database password in the connection URL secret", async () => {
    const secretString = resource(
      "aws:secretsmanager/secretVersion:SecretVersion",
      "llteacher-production-database-url-value",
    ).inputs.secretString as { value: string };
    expect(secretString.value).toBe(
      "postgres://llteacher:database%2Fpass@llteacher-production-postgres.database.test:5432/llteacher?sslmode=verify-full",
    );
    expect((resource("aws:secretsmanager/secretVersion:SecretVersion", "llteacher-local-database-url-value").inputs.secretString as { value: string }).value).toBe("postgres://llteacher:database%2Fpass@llteacher-local-postgres.database.test:5432/llteacher");
  });

  it("has identical local and production application graphs without NAT or background services", () => {
    const types = (prefix: string) => resources.filter(({ name }) => name.startsWith(prefix)).map(({ type }) => type).sort();
    expect(types("llteacher-local")).toEqual(types("llteacher-production"));
    expect(resources.filter(({ type }) => /natGateway|eip:|eventRule|eventTarget|sqs\/|cloudfront\//i.test(type))).toEqual([]);
    expect(types("llteacher-production").filter((type) => type === "aws:ecs/taskDefinition:TaskDefinition")).toHaveLength(1);
  });

  it("limits secret retrieval to both exact secret ARNs", () => {
    const policy = JSON.parse(String(resource("aws:iam/rolePolicy:RolePolicy", "llteacher-production-secrets-policy").inputs.policy));
    expect(policy.Statement).toEqual([{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: ["arn:aws:test:us-east-1:000000000000:llteacher-production-database-url", "arn:aws:test:us-east-1:000000000000:llteacher-production-runtime"] }]);
  });

  it("injects secrets separately from ordinary task configuration", () => {
    const [container] = JSON.parse(String(resource("aws:ecs/taskDefinition:TaskDefinition", "llteacher-production-app-task").inputs.containerDefinitions));
    expect(container.secrets.map((s: { name: string }) => s.name).sort()).toEqual(["DATABASE_URL", "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_WEBHOOK_SECRET", "OPENROUTER_API_KEY", "LLMOXIE_API_KEY", "SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"].sort());
    expect(container.environment).toEqual(expect.arrayContaining([{ name: "AWS_REGION", value: "us-west-2" }, { name: "APP_URL", value: "https://llteacher.example.edu" }]));
    expect(container.environment.map((v: { name: string }) => v.name)).toContain("STORAGE_BUCKET");
    expect(container.environment.map((v: { name: string }) => v.name)).not.toContain("STORAGE_ENDPOINT");
  });

  it("keeps S3 private and recoverable with least-privilege object access", () => {
    expect(resource("aws:s3/bucketVersioningV2:BucketVersioningV2", "llteacher-production-materials-versioning").inputs.versioningConfiguration).toEqual({ status: "Enabled" });
    expect(resource("aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2", "llteacher-production-materials-lifecycle").inputs.rules).toEqual([{ id: "expire-noncurrent", status: "Enabled", noncurrentVersionExpiration: { noncurrentDays: 30 } }]);
    expect(resource("aws:s3/bucket:Bucket", "llteacher-production-materials").inputs.serverSideEncryptionConfiguration).toBeDefined();
    const policy = JSON.parse(String(resource("aws:iam/rolePolicy:RolePolicy", "llteacher-production-materials-policy").inputs.policy));
    expect(policy.Statement).toEqual([
      { Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:test:us-east-1:000000000000:llteacher-production-materials", Condition: { StringLike: { "s3:prefix": ["courses/*/materials/*", "courses/*/knowledge/*"] } } },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: ["arn:aws:test:us-east-1:000000000000:llteacher-production-materials/courses/*/materials/*", "arn:aws:test:us-east-1:000000000000:llteacher-production-materials/courses/*/knowledge/*"] },
    ]);
  });

  it("keeps exactly one durable-knowledge writer during deployments", () => {
    expect(resource("aws:ecs/service:Service", "llteacher-production-app-service").inputs).toMatchObject({
      desiredCount: 1,
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
    });
  });

  it("only permits ALB-to-app and app-to-database ingress", () => {
    expect(resource("aws:ec2/securityGroup:SecurityGroup", "llteacher-production-app-sg").inputs.ingress).toEqual([{ fromPort: 8080, toPort: 8080, protocol: "tcp", securityGroups: ["llteacher-production-alb-sg-id"] }]);
    expect(resource("aws:ec2/securityGroup:SecurityGroup", "llteacher-production-database-sg").inputs.ingress).toEqual([{ fromPort: 5432, toPort: 5432, protocol: "tcp", securityGroups: ["llteacher-production-app-sg-id"] }]);
  });

  it("gives the application a startup grace period", async () => {
    expect(resource("aws:ecs/service:Service", "llteacher-production-app-service").inputs.healthCheckGracePeriodSeconds).toBe(60);
  });
  it("retains prior task revisions for migration safety and rollback", () => {
    expect(resource("aws:ecs/taskDefinition:TaskDefinition", "llteacher-production-app-task").inputs.skipDestroy).toBe(true);
  });
});
