import { describe, expect, it } from "vitest";
import { validateProductionCertificate } from "./dns.js";

const arn = "arn:aws:acm:us-west-2:055237683908:certificate/11111111-2222-3333-4444-555555555555";
const certificate = { arn, domainName: "learn.example.edu", status: "ISSUED", tags: { LLTeacherStack: "production" } };

describe("operator-owned production certificate", () => {
  it("returns the verified ARN for the listener", () => {
    expect(validateProductionCertificate(arn, "learn.example.edu", certificate)).toBe(arn);
  });
  it("rejects a different certificate, domain, ownership, or incomplete issuance", () => {
    for (const invalid of [
      { ...certificate, arn: `${arn}wrong` },
      { ...certificate, domainName: "unrelated.example.edu" },
      { ...certificate, tags: {} },
      { ...certificate, tags: { LLTeacherStack: "staging" } },
      { ...certificate, status: "PENDING_VALIDATION" },
    ]) expect(() => validateProductionCertificate(arn, "learn.example.edu", invalid)).toThrow("certificate");
  });
});
