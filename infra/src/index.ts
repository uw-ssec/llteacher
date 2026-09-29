import { createApplication } from "./app.js";
import { loadInfraConfig } from "./config.js";
import { createDataResources } from "./database.js";
import { loadDeploymentInputs } from "./deployment-inputs.js";
import { createNetwork } from "./network.js";
import { createAwsProvider } from "./provider.js";

const config = loadInfraConfig();
const deploymentInputs = loadDeploymentInputs(config.environment);
const name = `llteacher-${config.environment}`;
const provider = createAwsProvider(config);
const network = createNetwork(name, provider, config);
const data = createDataResources(name, config, network, provider, deploymentInputs);
const app = createApplication(name, config, network, data, provider, deploymentInputs);

export const appUrl = app.appUrl;
export const ecrRepositoryUrl = app.repository.repositoryUrl;
export const materialsBucketName = data.materialsBucket.bucket;
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
