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
const certificateArn = "arn:aws:acm:us-west-2:055237683908:certificate/11111111-2222-3333-4444-555555555555";
const hostedZoneId = "Z0123456789ABCDEFGHIJ";
describe("deployment config", () => {
  it("supports institution-specific first-run identity configuration", () => {
    expect(loadInfraConfig(reader({
      ...settings,
      bootstrapAllowedDomains: "example.edu,cs.example.edu",
      superAdminEmails: "operator@example.edu",
    }), aws)).toMatchObject({
      bootstrapAllowedDomains: "example.edu,cs.example.edu",
      superAdminEmails: "operator@example.edu",
    });
    expect(() => loadInfraConfig(reader({ ...settings, bootstrapAllowedDomains: "not a domain" }), aws)).toThrow("bootstrapAllowedDomains");
    expect(() => loadInfraConfig(reader({ ...settings, superAdminEmails: "not-an-email" }), aws)).toThrow("superAdminEmails");
  });
  it("requires an existing certificate only for production HTTPS activation", () => {
    const production = { environment: "production", domainName: "learn.example.edu", hostedZoneId, imageTag: "release", deployApp: "false" };
    expect(loadInfraConfig(reader(production), aws).domainReady).toBe(false);
    expect(() => loadInfraConfig(reader({ ...production, domainReady: "true" }), aws)).toThrow("certificateArn");
    expect(loadInfraConfig(reader({ ...production, domainReady: "true", certificateArn }), aws).certificateArn).toBe(certificateArn);
  });
  it("rejects certificate ARNs outside the exact production account/region or with malformed IDs", () => {
    const production = { environment: "production", domainName: "learn.example.edu", hostedZoneId, domainReady: "true", imageTag: "release" };
    for (const invalid of [certificateArn.replace("us-west-2", "us-east-1"), certificateArn.replace("055237683908", "111111111111"), certificateArn.replace("11111111-2222-3333-4444-555555555555", "*"), `${certificateArn}/extra`]) {
      expect(() => loadInfraConfig(reader({ ...production, certificateArn: invalid }), aws)).toThrow("certificateArn");
    }
  });
  it("keeps existing certificate configuration production-only", () => {
    expect(() => loadInfraConfig(reader({ ...settings, certificateArn }), aws)).toThrow("production");
    expect(() => loadInfraConfig(reader({ environment: "staging", imageTag: "release", certificateArn }), aws)).toThrow("production");
    expect(() => loadInfraConfig(reader({ ...settings, domainName: "llteacher.local", domainReady: "true" }), aws)).not.toThrow();
  });
  it("requires the exact existing hosted zone for a production domain", () => {
    const production = { environment: "production", domainName: "llteacher.org", hostedZoneId, imageTag: "release", deployApp: "false" };
    expect(loadInfraConfig(reader(production), aws).hostedZoneId).toBe(hostedZoneId);
    expect(() => loadInfraConfig(reader({ ...production, hostedZoneId: "" }), aws)).toThrow("hostedZoneId");
    for (const invalid of ["0123456789", "Z123/hostedzone", "z0123456789", "Z123-INVALID"]) {
      expect(() => loadInfraConfig(reader({ ...production, hostedZoneId: invalid }), aws)).toThrow("hostedZoneId");
    }
  });
  it("keeps an existing hosted zone reference production-only", () => {
    expect(() => loadInfraConfig(reader({ ...settings, hostedZoneId }), aws)).toThrow("production");
    expect(() => loadInfraConfig(reader({ environment: "staging", domainName: "staging.example.edu", hostedZoneId, imageTag: "release" }), aws)).toThrow("production");
  });
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
    expect(() => loadInfraConfig(reader({ environment: "production", imageTag: "release", domainReady: "true", domainName: "https://learn.example.edu/path", hostedZoneId }), aws)).toThrow(
      "domainName must be a DNS hostname",
    );
  });
  it("refuses to activate the production app without HTTPS", () => {
    expect(() => loadInfraConfig(reader({ environment: "production", imageTag: "release", deployApp: "true" }), aws)).toThrow(
      "Production app activation requires domainReady=true",
    );
  });
  it("isolates endpoint overrides to local", () => {
    expect(() => loadInfraConfig(reader({ ...settings, environment: "production", domainName: "learn.example.edu", hostedZoneId, domainReady: "true" }), aws)).toThrow("must not set");
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
    const prod = loadInfraConfig(reader({ environment: "production", domainName: "learn.example.edu", hostedZoneId, domainReady: "true", certificateArn, imageTag: "sha-123", imageDigest: `sha256:${"a".repeat(64)}` }), aws);
    expect(resolveApplicationImage(prod, "llteacher-production", "123.dkr.ecr.us-west-2.amazonaws.com/app")).toBe(`123.dkr.ecr.us-west-2.amazonaws.com/app@sha256:${"a".repeat(64)}`);
    expect(() => loadInfraConfig(reader({ ...settings, imageDigest: "latest" }), aws)).toThrow("imageDigest");
  });
});
