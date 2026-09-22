import * as pulumi from "@pulumi/pulumi";
import { createApplication } from "./app.js";
import { loadInfraConfig } from "./config.js";
import { createDataResources } from "./database.js";
import { createNetwork } from "./network.js";
import { createAwsProvider } from "./provider.js";

const config = loadInfraConfig();
const name = `llteacher-${config.environment}`;
const provider = createAwsProvider(config);
const network = createNetwork(name, provider, config);
const data = createDataResources(name, config, network, provider);
const app = createApplication(name, config, network, data, provider);

export const appUrl = app.appUrl;
export const ecrRepositoryUrl = app.repository.repositoryUrl;
export const materialsBucketName = data.materialsBucket.bucket;
export const logGroupNames = pulumi.all([app.logGroup.name]);
export const logGroupName = app.logGroup.name;
export const candidateTaskDefinitionArn = app.taskDefinition.arn;
export const clusterName = app.cluster.name;
export const serviceName = app.service?.name;
export const serviceTaskDefinition = app.service?.taskDefinition;
// This is the candidate digest; a pinned service may still run an older image.
export const imageDigest = config.imageDigest;
export const hostedZoneNameServers = app.dns?.hostedZone.nameServers;
export const appSubnetIds = network.appSubnetIds;
export const appSecurityGroupId = network.appSecurityGroup.id;
