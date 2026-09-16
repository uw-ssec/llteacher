import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { InfraConfig } from "./config.js";
import type { Database } from "./database.js";
import type { Network } from "./network.js";

export interface Application {
  appUrl: pulumi.Output<string>;
  cluster: aws.ecs.Cluster;
  executionRole: aws.iam.Role;
  imageTag: string;
  logGroup: aws.cloudwatch.LogGroup;
  repository: aws.ecr.Repository;
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
    containerDefinitions: pulumi.all([repository.repositoryUrl, logGroup.name, data.databaseUrlSecret.arn]).apply(([repositoryUrl, logGroupName, databaseSecretArn]) => JSON.stringify([{
      name: "app",
      image: `${repositoryUrl}:${config.imageTag}`,
      essential: true,
      portMappings: [{ containerPort: 8080, protocol: "tcp" }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroupName, "awslogs-region": "us-east-1", "awslogs-stream-prefix": "app" } },
      secrets: [{ name: "DATABASE_URL", valueFrom: databaseSecretArn }],
    }])),
  }, { ...options, dependsOn: [data.databaseUrlSecretVersion] });
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
  new aws.lb.Listener(`${name}-https-listener`, {
    certificateArn: certificate.arn,
    defaultActions: [{ targetGroupArn: targetGroup.arn, type: "forward" }],
    loadBalancerArn: alb.arn,
    port: 443,
    protocol: "HTTPS",
  }, options);
  new aws.ecs.Service(`${name}-app-service`, {
    cluster: cluster.arn,
    desiredCount: config.deployApp ? 1 : 0,
    launchType: "FARGATE",
    loadBalancers: [{ containerName: "app", containerPort: 8080, targetGroupArn: targetGroup.arn }],
    name: `${name}-app`,
    networkConfiguration: { assignPublicIp: true, securityGroups: [network.appSecurityGroup.id], subnets: network.publicSubnetIds },
    taskDefinition: taskDefinition.arn,
  }, options);
  return { appUrl: pulumi.interpolate`https://${config.domainName}`, cluster, executionRole, imageTag: config.imageTag, logGroup, repository, taskDefinition };
}
