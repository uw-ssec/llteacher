import { describe, expect, it } from "vitest";
import { loadInfraConfig } from "./config.js";
import { resolveApplicationImage } from "./provider.js";
function reader(values: Record<string, string>) {
  return { get: (key: string) => values[key], require: (key: string) => {
    if (!values[key]) throw new Error(`missing ${key}`);
    return values[key];
  } };
}
const aws = reader({ region: "us-west-2" });
const settings = { environment: "local", flociEndpoint: "http://localhost:4566", imageTag: "sha-123" };
describe("deployment config", () => {
  it("rejects an invalid environment", () => {
    expect(() => loadInfraConfig(reader({ ...settings, environment: "preview" }), aws)).toThrow(
      'must be local, staging, or production',
    );
  });
  it("enforces the regional deployment boundary", () => {
    expect(loadInfraConfig(reader(settings), aws).region).toBe("us-west-2");
    expect(() => loadInfraConfig(reader(settings), reader({ region: "us-east-1" }))).toThrow("us-west-2");
  });
  it("allows domainless HTTP bootstrap and explicit later DNS readiness", () => {
    expect(loadInfraConfig(reader({ environment: "production", imageTag: "bootstrap", deployApp: "false", provisionService: "false" }), aws)).toMatchObject({ domainName: undefined, domainReady: false, deployApp: false });
    expect(() => loadInfraConfig(reader({ ...settings, domainReady: "true" }), aws)).toThrow("domainName");
  });
  it("rejects malformed domain names before creating AWS resources", () => {
    expect(() => loadInfraConfig(reader({ environment: "production", imageTag: "release", domainReady: "true", domainName: "https://learn.example.edu/path" }), aws)).toThrow(
      "domainName must be a DNS hostname",
    );
  });
  it("refuses to activate the production app without HTTPS", () => {
    expect(() => loadInfraConfig(reader({ environment: "production", imageTag: "release", deployApp: "true" }), aws)).toThrow(
      "Production app activation requires domainReady=true",
    );
  });
  it("isolates endpoint overrides to local", () => {
    expect(() => loadInfraConfig(reader({ ...settings, environment: "production", domainName: "learn.example.edu", domainReady: "true" }), aws)).toThrow("must not set");
    expect(() => loadInfraConfig(reader({ environment: "local", imageTag: "local" }), aws)).toThrow("flociEndpoint");
    expect(() => loadInfraConfig(reader({ ...settings, flociEndpoint: "https://ecs.us-west-2.amazonaws.com" }), aws)).toThrow("local emulator");
  });
  it("limits an emulator origin override to local HTTP origins", () => {
    expect(loadInfraConfig(reader({ ...settings, appOrigin: "http://localhost:8080" }), aws).appOrigin).toBe("http://localhost:8080");
    expect(() => loadInfraConfig(reader({ environment: "production", imageTag: "a", appOrigin: "http://localhost:8080" }), aws)).toThrow("appOrigin");
  });
  it("resolves canonical local images and immutable AWS digests", () => {
    const local = loadInfraConfig(reader(settings), aws);
    expect(resolveApplicationImage(local, "llteacher-local", "localhost:5000/app")).toBe("000000000000.dkr.ecr.us-west-2.amazonaws.com/llteacher-local/app:sha-123");
    const prod = loadInfraConfig(reader({ environment: "production", domainName: "learn.example.edu", domainReady: "true", imageTag: "sha-123", imageDigest: `sha256:${"a".repeat(64)}` }), aws);
    expect(resolveApplicationImage(prod, "llteacher-production", "123.dkr.ecr.us-west-2.amazonaws.com/app")).toBe(`123.dkr.ecr.us-west-2.amazonaws.com/app@sha256:${"a".repeat(64)}`);
    expect(() => loadInfraConfig(reader({ ...settings, imageDigest: "latest" }), aws)).toThrow("imageDigest");
  });
});
