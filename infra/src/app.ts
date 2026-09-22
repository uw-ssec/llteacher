import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";
import type { Database } from "./database.js";
import type { Network } from "./network.js";
import { resolveApplicationImage } from "./provider.js";
import { createDnsResources, type DnsResources } from "./dns.js";

export interface Application {
  appUrl: pulumi.Output<string>;
  cluster: aws.ecs.Cluster;
  executionRole: aws.iam.Role;
  imageTag: string;
  logGroup: aws.cloudwatch.LogGroup;
  repository: aws.ecr.Repository;
  taskRole: aws.iam.Role;
  taskDefinition: aws.ecs.TaskDefinition;
  service?: aws.ecs.Service;
  dns?: DnsResources;
}

const assumeRolePolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" } }],
});

export function createApplication(name: string, config: InfraConfig, network: Network, data: Database, provider: aws.Provider): Application {
  const options = { provider };
  const repository = new aws.ecr.Repository(`${name}-app`, { forceDelete: config.isLocal, name: `${name}/app` }, options);
  const logGroup = new aws.cloudwatch.LogGroup(`${name}-app-logs`, { retentionInDays: config.isLocal ? 7 : 30 }, options);
  const cluster = new aws.ecs.Cluster(`${name}-cluster`, { name: `${name}-cluster` }, options);
  const executionRole = new aws.iam.Role(`${name}-execution-role`, { assumeRolePolicy }, options);
  const taskRole = new aws.iam.Role(`${name}-task-role`, { assumeRolePolicy }, options);
  const executionPolicy = new aws.iam.RolePolicyAttachment(`${name}-execution-policy`, {
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    role: executionRole.name,
  }, options);
  const secretsPolicy = new aws.iam.RolePolicy(`${name}-secrets-policy`, {
    role: executionRole.id,
    policy: pulumi.all([data.databaseUrlSecret.arn, data.runtimeSecret.arn]).apply((arns) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: arns }],
    })),
  }, options);
  const materialsPolicy = new aws.iam.RolePolicy(`${name}-materials-policy`, {
    policy: pulumi.all([data.materialsBucket.arn]).apply(([bucketArn]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "s3:ListBucket", Resource: bucketArn },
        { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: `${bucketArn}/*` },
      ],
    })),
    role: taskRole.id,
  }, options);
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, { internal: false, loadBalancerType: "application", subnets: network.publicSubnetIds, securityGroups: [network.albSecurityGroup.id] }, options);
  const dns = createDnsResources(name, config, alb, provider);
  const appUrl = config.appOrigin ? pulumi.output(config.appOrigin) : config.domainReady ? pulumi.output(`https://${config.domainName}`) : pulumi.interpolate`http://${alb.dnsName}`;
  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-app-task`, {
    cpu: "512",
    executionRoleArn: executionRole.arn,
    family: `${name}-app`,
    // Candidate creation must not deregister the revision still serving traffic
    // or the rollback target retained by the release workflow.
    skipDestroy: true,
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.all([repository.repositoryUrl, logGroup.name, data.databaseUrlSecret.arn, data.runtimeSecret.arn, data.materialsBucket.bucket, appUrl]).apply(([repositoryUrl, logGroupName, databaseSecretArn, runtimeSecretArn, bucket, origin]) => JSON.stringify([{
      name: "app",
      image: resolveApplicationImage(config, name, repositoryUrl),
      essential: true,
      environment: [
        { name: "APP_URL", value: origin },
        { name: "AWS_REGION", value: config.region },
        { name: "STORAGE_BUCKET", value: bucket },
        { name: "PORT", value: "8080" },
        { name: "BUILD_SHA", value: config.buildSha ?? config.imageTag },
        { name: "KNOWLEDGE_ROOT", value: "/tmp/llteacher-knowledge" },
        ...(config.isLocal ? [
          { name: "STORAGE_ENDPOINT", value: config.storageEndpoint ?? "http://host.docker.internal:4566" },
          { name: "STORAGE_ACCESS_KEY_ID", value: "test" },
          { name: "STORAGE_SECRET_ACCESS_KEY", value: "test" },
        ] : []),
      ],
      portMappings: [{ containerPort: 8080, protocol: "tcp" }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroupName, "awslogs-region": config.region, "awslogs-stream-prefix": "app" } },
      secrets: [
        { name: "DATABASE_URL", valueFrom: databaseSecretArn },
        ...(!runtimeSecretArn ? [] : ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "OPENROUTER_API_KEY", "LLMOXIE_API_KEY", "SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY", "WORKOS_WEBHOOK_SECRET"].map((name) => ({ name, valueFrom: `${runtimeSecretArn}:${name}::` }))),
      ],
    }])),
  }, { ...options, dependsOn: [data.databaseUrlSecretVersion, data.runtimeSecretVersion, executionPolicy, secretsPolicy, materialsPolicy] });
  const targetGroup = new aws.lb.TargetGroup(`${name}-app-targets`, {
    healthCheck: { matcher: "200", path: "/api/health" },
    name: `llt-${config.environment}-app`,
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: network.vpc.id,
  }, options);
  const listener = new aws.lb.Listener(`${name}-listener`, {
    certificateArn: config.domainReady ? dns!.certificateArn : undefined,
    defaultActions: [{ targetGroupArn: targetGroup.arn, type: "forward" }],
    loadBalancerArn: alb.arn,
    port: config.domainReady ? 443 : 80,
    protocol: config.domainReady ? "HTTPS" : "HTTP",
  }, options);
  let service: aws.ecs.Service | undefined;
  if (config.provisionService) {
    service = new aws.ecs.Service(`${name}-app-service`, {
      cluster: cluster.arn,
      desiredCount: config.deployApp ? 1 : 0,
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
      healthCheckGracePeriodSeconds: 60,
      launchType: "FARGATE",
      loadBalancers: [{ containerName: "app", containerPort: 8080, targetGroupArn: targetGroup.arn }],
      name: `${name}-app`,
      networkConfiguration: { assignPublicIp: true, securityGroups: [network.appSecurityGroup.id], subnets: network.appSubnetIds },
      taskDefinition: config.serviceTaskDefinition ?? taskDefinition.arn,
    }, { ...options, dependsOn: [listener] });
  }
  return { appUrl, cluster, executionRole, imageTag: config.imageTag, logGroup, repository, taskDefinition, taskRole, service, dns };
}
