import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./app.js";
import type { InfraConfig } from "./config.js";
import { createDataResources } from "./database.js";
import { createNetwork, type Network } from "./network.js";
import { createOverdueJob } from "./scheduled-job.js";

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
  hostedZoneId: "Z123456789",
  deployApp: true,
  provisionService: true,
  imageTag: "sha-123",
  endpoints: {},
} satisfies InfraConfig & { hostedZoneId: string };

async function createProductionGraph() {
  const provider = new aws.Provider("test-provider", { region: "us-east-1" });
  const network = (createNetwork as unknown as (
    name: string,
    provider: aws.Provider,
    config: InfraConfig,
  ) => Network)("llteacher-production", provider, productionConfig);
  const data = createDataResources("llteacher-production", productionConfig, network, provider);
  const app = createApplication("llteacher-production", productionConfig, network, data, provider);
  createOverdueJob("llteacher-production", productionConfig, app, data, network, provider);
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
  });

  it("places application and database resources in private subnets", async () => {
    const publicSubnets = resources.filter(({ type, inputs }) => type === "aws:ec2/subnet:Subnet" && inputs.mapPublicIpOnLaunch === true);
    const privateSubnets = resources.filter(({ type, inputs }) => type === "aws:ec2/subnet:Subnet" && inputs.mapPublicIpOnLaunch === false);
    expect(publicSubnets).toHaveLength(2);
    expect(privateSubnets).toHaveLength(2);

    const dbSubnetGroup = resource("aws:rds/subnetGroup:SubnetGroup", "llteacher-production-db-subnets");
    const service = resource("aws:ecs/service:Service", "llteacher-production-app-service");
    expect(dbSubnetGroup.inputs.subnetIds).toEqual(privateSubnets.map(({ name }) => `${name}-id`));
    expect(service.inputs.networkConfiguration).toMatchObject({
      assignPublicIp: false,
      subnets: privateSubnets.map(({ name }) => `${name}-id`),
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
      "postgres://llteacher:database%2Fpass@llteacher-production-postgres.database.test:5432/llteacher",
    );
  });

  it("scopes EventBridge pass-role and configures retry and dead-letter handling", async () => {
    const policy = JSON.parse(String(resource("aws:iam/rolePolicy:RolePolicy", "llteacher-production-eventbridge-run-task").inputs.policy));
    const passRole = policy.Statement.find((statement: { Action: string }) => statement.Action === "iam:PassRole");
    expect(passRole.Resource).not.toBe("*");
    expect(passRole.Resource).toEqual(expect.arrayContaining([
      expect.stringContaining("llteacher-production-execution-role"),
      expect.stringContaining("llteacher-production-task-role"),
    ]));

    expect(resource("aws:cloudwatch/eventTarget:EventTarget", "llteacher-production-overdue-target").inputs).toMatchObject({
      deadLetterConfig: { arn: expect.stringContaining("overdue-dlq") },
      retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 3 },
    });
    expect(resources.some(({ type }) => type === "aws:cloudwatch/metricAlarm:MetricAlarm")).toBe(true);
  });

  it("gives the application a startup grace period", async () => {
    expect(resource("aws:ecs/service:Service", "llteacher-production-app-service").inputs.healthCheckGracePeriodSeconds).toBe(60);
  });
});
