import * as pulumi from "@pulumi/pulumi";

export type Environment = "local" | "staging" | "production";

export interface InfraConfig {
  environment: Environment;
  isLocal: boolean;
  region: string;
  domainName?: string;
  certificateArn?: string;
  domainReady: boolean;
  imageDigest?: string;
  buildSha?: string;
  serviceTaskDefinition?: string;
  storageEndpoint?: string;
  appOrigin?: string;
  deployApp: boolean;
  provisionService: boolean;
  imageTag: string;
  endpoints: {
    floci?: string;
  };
}

interface ConfigReader {
  get(key: string): string | undefined;
  require(key: string): string;
}

function loadEnvironment(config: ConfigReader): Environment {
  const environment = config.require("environment");
  if (
    environment !== "local" &&
    environment !== "staging" &&
    environment !== "production"
  ) {
    throw new Error(
      'The "environment" configuration value must be local, staging, or production.',
    );
  }

  return environment;
}

/**
 * Loads non-secret deployment settings. Credentials and application secrets
 * are intentionally excluded and will be loaded as Pulumi secrets only when
 * a resource explicitly needs them.
 */
export function loadInfraConfig(config: ConfigReader = new pulumi.Config(), awsConfig: ConfigReader = new pulumi.Config("aws")): InfraConfig {
  const environment = loadEnvironment(config);
  const flociEndpoint = config.get("flociEndpoint");
  const region = awsConfig.require("region");
  if (region !== "us-west-2") throw new Error("All stacks must use aws:region us-west-2.");
  const domainName = config.get("domainName") || undefined;
  if (domainName && (domainName.length > 253 || !/^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domainName))) {
    throw new Error("domainName must be a DNS hostname such as learn.example.edu.");
  }
  const appOrigin = config.get("appOrigin");
  if (appOrigin) {
    const url = new URL(appOrigin);
    if (environment !== "local" || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== appOrigin) {
      throw new Error("appOrigin is only allowed as a local emulator HTTP origin.");
    }
  }
  const domainReady = config.get("domainReady") === "true";
  if (domainReady && !domainName) throw new Error("domainReady requires domainName.");
  const imageDigest = config.get("imageDigest");
  if (imageDigest && !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("imageDigest must be a sha256 digest.");
  const deployApp = config.get("deployApp") !== "false";
  const provisionService = config.get("provisionService") !== "false";
  if (environment === "production" && deployApp && !domainReady) {
    throw new Error("Production app activation requires domainReady=true and an HTTPS domain.");
  }

  if (environment === "local" && !flociEndpoint) {
    throw new Error('The local stack requires a "flociEndpoint" configuration value.');
  }

  if (environment !== "local" && flociEndpoint) {
    throw new Error(`The ${environment} stack must not set "flociEndpoint".`);
  }

  if (flociEndpoint) {
    const url = new URL(flociEndpoint);
    if (!["localhost", "127.0.0.1", "[::1]", "floci", "host.docker.internal"].includes(url.hostname) || url.protocol !== "http:") {
      throw new Error("flociEndpoint must address a local emulator over HTTP.");
    }
  }

  const certificateArn = config.get("certificateArn") || undefined;
  if (certificateArn && (environment !== "production" || !/^arn:aws:acm:us-west-2:055237683908:certificate\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(certificateArn))) {
    throw new Error("certificateArn must identify a production ACM certificate in account 055237683908, us-west-2, with a UUID ID.");
  }
  if (environment === "production" && domainReady && !certificateArn) {
    throw new Error("Production domainReady=true requires an operator-provisioned certificateArn.");
  }

  return {
    environment,
    isLocal: environment === "local",
    region,
    domainName,
    certificateArn,
    appOrigin,
    domainReady,
    imageDigest,
    buildSha: config.get("buildSha"),
    serviceTaskDefinition: config.get("serviceTaskDefinition"),
    storageEndpoint: environment === "local" ? config.get("storageEndpoint") ?? "http://host.docker.internal:4566" : undefined,
    deployApp,
    provisionService,
    imageTag: config.require("imageTag"),
    endpoints: flociEndpoint === undefined ? {} : { floci: flociEndpoint },
  };
}
