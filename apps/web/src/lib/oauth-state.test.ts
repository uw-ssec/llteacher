import { describe, it, expect } from "vitest";
import { generateState, generatePkceVerifier, computeCodeChallenge } from "./oauth-state";

describe("generateState / generatePkceVerifier", () => {
  it("produces different values on each call", () => {
    expect(generateState()).not.toBe(generateState());
    expect(generatePkceVerifier()).not.toBe(generatePkceVerifier());
  });

  it("produces URL-safe strings (no padding, +, /)", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("computeCodeChallenge", () => {
  it("is deterministic for the same verifier", async () => {
    const verifier = generatePkceVerifier();
    expect(await computeCodeChallenge(verifier)).toBe(await computeCodeChallenge(verifier));
  });

  it("differs for different verifiers", async () => {
    const a = await computeCodeChallenge(generatePkceVerifier());
    const b = await computeCodeChallenge(generatePkceVerifier());
    expect(a).not.toBe(b);
  });

  it("matches the RFC 7636 Appendix B test vector", async () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // must produce challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await computeCodeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
