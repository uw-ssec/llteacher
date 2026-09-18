import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";
import type { Database } from "./database.js";
import type { Network } from "./network.js";
import { resolveApplicationImage } from "./provider.js";

export interface Application {
  appUrl: pulumi.Output<string>;
  cluster: aws.ecs.Cluster;
  executionRole: aws.iam.Role;
  imageTag: string;
  logGroup: aws.cloudwatch.LogGroup;
  repository: aws.ecr.Repository;
  taskRole: aws.iam.Role;
  taskDefinition: aws.ecs.TaskDefinition;
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
  new aws.iam.RolePolicyAttachment(`${name}-execution-policy`, {
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    role: executionRole.name,
  }, options);
  new aws.iam.RolePolicy(`${name}-materials-policy`, {
    policy: pulumi.all([data.materialsBucket.arn]).apply(([bucketArn]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], Effect: "Allow", Resource: [bucketArn, `${bucketArn}/*`] }],
    })),
    role: taskRole.id,
  }, options);
  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-app-task`, {
    cpu: "512",
    executionRoleArn: executionRole.arn,
    family: `${name}-app`,
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.all([repository.repositoryUrl, logGroup.name, data.databaseUrlSecret.arn, data.runtimeSecret?.arn]).apply(([repositoryUrl, logGroupName, databaseSecretArn, runtimeSecretArn]) => JSON.stringify([{
      name: "app",
      image: resolveApplicationImage(config, name, repositoryUrl),
      essential: true,
      environment: [{ name: "APP_URL", value: `https://${config.domainName}` }],
      portMappings: [{ containerPort: 8080, protocol: "tcp" }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroupName, "awslogs-region": "us-east-1", "awslogs-stream-prefix": "app" } },
      secrets: [
        { name: "DATABASE_URL", valueFrom: databaseSecretArn },
        ...(!runtimeSecretArn ? [] : ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "OPENROUTER_API_KEY", "LLMOXIE_API_KEY", "SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY", "WORKOS_WEBHOOK_SECRET"].map((name) => ({ name, valueFrom: `${runtimeSecretArn}:${name}::` }))),
      ],
    }])),
  }, { ...options, dependsOn: [data.databaseUrlSecretVersion, ...(data.runtimeSecretVersion ? [data.runtimeSecretVersion] : [])] });
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, { internal: false, loadBalancerType: "application", subnets: network.publicSubnetIds, securityGroups: [network.albSecurityGroup.id] }, options);
  const targetGroup = new aws.lb.TargetGroup(`${name}-app-targets`, {
    healthCheck: { matcher: "200-399", path: "/" },
    name: `llt-${config.environment}-app`,
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: network.vpc.id,
  }, options);
  const certificate = new aws.acm.Certificate(`${name}-certificate`, { domainName: config.domainName, validationMethod: "DNS" }, options);
  const certificateArn = config.isLocal ? certificate.arn : (() => {
    const validationRecord = new aws.route53.Record(`${name}-certificate-validation-record`, {
      allowOverwrite: true,
      name: certificate.domainValidationOptions.apply((options) => options[0].resourceRecordName),
      records: [certificate.domainValidationOptions.apply((options) => options[0].resourceRecordValue)],
      ttl: 60,
      type: certificate.domainValidationOptions.apply((options) => options[0].resourceRecordType),
      zoneId: config.hostedZoneId!,
    }, options);
    return new aws.acm.CertificateValidation(`${name}-certificate-validation`, {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    }, options).certificateArn;
  })();
  const listener = new aws.lb.Listener(`${name}-https-listener`, {
    certificateArn,
    defaultActions: [{ targetGroupArn: targetGroup.arn, type: "forward" }],
    loadBalancerArn: alb.arn,
    port: 443,
    protocol: "HTTPS",
  }, options);
  if (config.provisionService) {
    new aws.ecs.Service(`${name}-app-service`, {
      cluster: cluster.arn,
      desiredCount: config.deployApp ? 1 : 0,
      healthCheckGracePeriodSeconds: 60,
      launchType: "FARGATE",
      loadBalancers: [{ containerName: "app", containerPort: 8080, targetGroupArn: targetGroup.arn }],
      name: `${name}-app`,
      networkConfiguration: { assignPublicIp: config.isLocal, securityGroups: [network.appSecurityGroup.id], subnets: network.appSubnetIds },
      taskDefinition: taskDefinition.arn,
    }, { ...options, dependsOn: [listener] });
  }
  return { appUrl: pulumi.interpolate`https://${config.domainName}`, cluster, executionRole, imageTag: config.imageTag, logGroup, repository, taskDefinition, taskRole };
}
