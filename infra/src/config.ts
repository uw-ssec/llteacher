import * as pulumi from "@pulumi/pulumi";

export type Environment = "local" | "staging" | "production";

export interface InfraConfig {
  environment: Environment;
  isLocal: boolean;
  domainName: string;
  hostedZoneId?: string;
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
export function loadInfraConfig(config: ConfigReader = new pulumi.Config()): InfraConfig {
  const environment = loadEnvironment(config);
  const flociEndpoint = config.get("flociEndpoint");
  const hostedZoneId = config.get("hostedZoneId");
  const deployApp = config.get("deployApp") !== "false";
  const provisionService = config.get("provisionService") !== "false";

  if (environment === "local" && !flociEndpoint) {
    throw new Error('The local stack requires a "flociEndpoint" configuration value.');
  }

  if (environment !== "local" && flociEndpoint) {
    throw new Error(`The ${environment} stack must not set "flociEndpoint".`);
  }

  if (environment !== "local" && !hostedZoneId) {
    throw new Error(`The ${environment} stack requires a "hostedZoneId" configuration value.`);
  }

  return {
    environment,
    isLocal: environment === "local",
    domainName: config.require("domainName"),
    ...(hostedZoneId === undefined ? {} : { hostedZoneId }),
    deployApp,
    provisionService,
    imageTag: config.require("imageTag"),
    endpoints: flociEndpoint === undefined ? {} : { floci: flociEndpoint },
  };
}
