import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { Application } from "./app.js";
import type { InfraConfig } from "./config.js";
import type { Database } from "./database.js";
import type { Network } from "./network.js";

/** The existing overdue-submission sweep, isolated as a short-lived ECS task. */
export function createOverdueJob(name: string, config: InfraConfig, app: Application, data: Database, network: Network, provider: aws.Provider): aws.cloudwatch.LogGroup {
  const options = { provider };
  const logGroup = new aws.cloudwatch.LogGroup(`${name}-overdue-job-logs`, { retentionInDays: 7 }, options);
  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-overdue-job-task`, {
    cpu: "256",
    executionRoleArn: app.executionRole.arn,
    family: `${name}-overdue-job`,
    memory: "512",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    taskRoleArn: app.taskRole.arn,
    containerDefinitions: pulumi.all([app.repository.repositoryUrl, logGroup.name, data.databaseUrlSecret.arn]).apply(([repositoryUrl, logGroupName, databaseSecretArn]) => JSON.stringify([{
      name: "overdue-job",
      image: `${repositoryUrl}:${app.imageTag}`,
      command: ["npm", "run", "node:run-overdue-job"],
      essential: true,
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroupName, "awslogs-region": "us-east-1", "awslogs-stream-prefix": "job" } },
      secrets: [{ name: "DATABASE_URL", valueFrom: databaseSecretArn }],
    }])),
  }, options);
  const role = new aws.iam.Role(`${name}-eventbridge-role`, {
    assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "events.amazonaws.com" } }] }),
  }, options);
  // Floci currently loops an ECS task-state event back through the EventBridge
  // ECS target. Keep the local rule represented but disabled; staging and
  // production run the real hourly overdue-submission sweep.
  const rule = new aws.cloudwatch.EventRule(`${name}-overdue-hourly`, {
    isEnabled: !config.isLocal,
    scheduleExpression: "rate(1 hour)",
  }, options);
  new aws.iam.RolePolicy(`${name}-eventbridge-run-task`, {
    policy: pulumi.all([taskDefinition.arn, app.executionRole.arn, app.taskRole.arn]).apply(([taskArn, executionRoleArn, taskRoleArn]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Action: "ecs:RunTask", Effect: "Allow", Resource: taskArn },
        { Action: "iam:PassRole", Effect: "Allow", Resource: [executionRoleArn, taskRoleArn] },
      ],
    })),
    role: role.id,
  }, options);
  const deadLetterQueue = config.isLocal ? undefined : new aws.sqs.Queue(`${name}-overdue-dlq`, {
    messageRetentionSeconds: 1_209_600,
  }, options);
  if (deadLetterQueue) {
    new aws.sqs.QueuePolicy(`${name}-overdue-dlq-policy`, {
      policy: pulumi.all([deadLetterQueue.arn, rule.arn]).apply(([queueArn, ruleArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sqs:SendMessage",
          Condition: { ArnEquals: { "aws:SourceArn": ruleArn } },
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Resource: queueArn,
        }],
      })),
      queueUrl: deadLetterQueue.url,
    }, options);
    new aws.cloudwatch.MetricAlarm(`${name}-overdue-dlq-visible`, {
      alarmDescription: "The overdue-submission job exhausted EventBridge retries.",
      comparisonOperator: "GreaterThanThreshold",
      dimensions: { QueueName: deadLetterQueue.name },
      evaluationPeriods: 1,
      metricName: "ApproximateNumberOfMessagesVisible",
      namespace: "AWS/SQS",
      period: 300,
      statistic: "Maximum",
      threshold: 0,
    }, options);
  }
  new aws.cloudwatch.EventTarget(`${name}-overdue-target`, {
    arn: app.cluster.arn,
    ...(deadLetterQueue ? {
      deadLetterConfig: { arn: deadLetterQueue.arn },
      retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 3 },
    } : {}),
    ecsTarget: {
      launchType: "FARGATE",
      networkConfiguration: { assignPublicIp: config.isLocal, securityGroups: [network.appSecurityGroup.id], subnets: network.appSubnetIds },
      taskCount: 1,
      taskDefinitionArn: taskDefinition.arn,
    },
    roleArn: role.arn,
    rule: rule.name,
  }, options);
  return logGroup;
}
