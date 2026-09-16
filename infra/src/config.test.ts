import { describe, expect, it } from "vitest";

import { loadInfraConfig } from "./config.js";

type Values = Record<string, string | undefined>;

function config(values: Values) {
  return {
    get: (key: string) => values[key],
    require: (key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`missing ${key}`);
      }
      return value;
    },
  };
}

describe("loadInfraConfig", () => {
  it("requires a Floci endpoint for the local stack", () => {
    expect(() =>
      loadInfraConfig(
        config({
          environment: "local",
          domainName: "llteacher.local",
          deployApp: "false",
          imageTag: "local",
        }),
      ),
    ).toThrow('The local stack requires a "flociEndpoint" configuration value.');
  });

  it("rejects a Floci endpoint for the production stack", () => {
    expect(() =>
      loadInfraConfig(
        config({
          environment: "production",
          domainName: "llteacher.example.com",
          imageTag: "release-2026-09-15",
          flociEndpoint: "http://localhost:4566",
        }),
      ),
    ).toThrow('The production stack must not set "flociEndpoint".');
  });

  it("rejects a Floci endpoint for the staging stack", () => {
    expect(() =>
      loadInfraConfig(
        config({
          environment: "staging",
          domainName: "staging.llteacher.com",
          imageTag: "candidate",
          flociEndpoint: "http://localhost:4566",
        }),
      ),
    ).toThrow('The staging stack must not set "flociEndpoint".');
  });

  it("rejects an unknown deployment environment", () => {
    expect(() =>
      loadInfraConfig(
        config({
          environment: "test",
          domainName: "llteacher.test",
          imageTag: "test",
        }),
      ),
    ).toThrow(
      'The "environment" configuration value must be local, staging, or production.',
    );
  });

  it("returns non-secret local deployment settings", () => {
    expect(
      loadInfraConfig(
        config({
          environment: "local",
          domainName: "llteacher.local",
          deployApp: "false",
          imageTag: "local",
          flociEndpoint: "http://localhost:4566",
        }),
      ),
    ).toEqual({
      environment: "local",
      isLocal: true,
      domainName: "llteacher.local",
      deployApp: false,
      imageTag: "local",
      endpoints: { floci: "http://localhost:4566" },
    });
  });
});
