import { describe, it, expect, vi, beforeEach } from "vitest";
import { webhooksWorkos } from "./webhooksWorkos";
import { getWorkOS } from "../../lib/workos";

const WEBHOOK_SECRET = "whsec_test_secret";
const TEST_ENV = {
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DATABASE_URL: "ignored",
} as Env;

vi.mock("../../db/client", () => ({
  makeDb: () => ({}),
}));

const claimWebhookEvent = vi.fn();
const recordWebhookEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../repositories/webhookEvents", () => ({
  claimWebhookEvent: (...args: unknown[]) => claimWebhookEvent(...args),
  recordWebhookEvent: (...args: unknown[]) => recordWebhookEvent(...args),
}));

const deactivateByWorkosUserId = vi.fn();
vi.mock("../repositories/users", () => ({
  deactivateByWorkosUserId: (...args: unknown[]) => deactivateByWorkosUserId(...args),
}));

const recordAuditEvent = vi.fn();
vi.mock("../repositories/auditEvents", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));

vi.mock("../../lib/secrets-loader", () => ({
  loadIdentityCipherKeys: async () => ({
    encryptionKey: {},
    blindIndexKey: {},
    encryptionKeyId: "k1",
  }),
}));

const handleEmailUpdated = vi.fn();
vi.mock("../../lib/services/UserIdentityService", () => ({
  UserIdentityService: class {
    handleEmailUpdated(...args: unknown[]) {
      return handleEmailUpdated(...args);
    }
  },
}));

/** Signs a payload the same way WorkOS itself would, using the real SDK's
 *  own HMAC-SHA256 implementation (not a hand-rolled one) -- this proves
 *  the handler's verification path actually works against real WorkOS
 *  signing logic, not just against a mock that always says "valid." */
async function signedRequest(payload: unknown, secret = WEBHOOK_SECRET, timestamp = Date.now()) {
  const workos = getWorkOS(TEST_ENV.WORKOS_API_KEY);
  const signatureHash = await workos.webhooks.computeSignature(timestamp, payload, secret);
  const sigHeader = `t=${timestamp},v1=${signatureHash}`;
  return {
    method: "POST",
    headers: { "content-type": "application/json", "workos-signature": sigHeader },
    body: JSON.stringify(payload),
  };
}

/** Flips the last character of the signature hex to a value guaranteed to
 *  differ from the original -- `.replace(/.$/, "0")` (the prior version of
 *  this helper) was a silent no-op whenever the signature already happened
 *  to end in "0" (~1/16 of the time for a hex digest), making the test that
 *  used it flaky. */
function tamperSignature(sigHeader: string): string {
  const lastChar = sigHeader.at(-1);
  const replacement = lastChar === "0" ? "1" : "0";
  return sigHeader.slice(0, -1) + replacement;
}

function userEvent(id: string, event: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    event,
    createdAt: new Date().toISOString(),
    data: {
      object: "user",
      id: "workos_1",
      email: "user@uw.edu",
      emailVerified: true,
      profilePictureUrl: null,
      firstName: null,
      lastName: null,
      lastSignInAt: null,
      locale: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      externalId: null,
      metadata: {},
      ...overrides,
    },
  };
}

function userDeletedEvent(workosUserId: string) {
  return userEvent("event_1", "user.deleted", { id: workosUserId });
}

beforeEach(() => {
  deactivateByWorkosUserId.mockReset();
  recordAuditEvent.mockReset();
  handleEmailUpdated.mockReset();
  claimWebhookEvent.mockReset().mockResolvedValue(true);
  recordWebhookEvent.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/webhooks/workos", () => {
  it("returns 401 with no signature header at all", async () => {
    const res = await webhooksWorkos.request(
      "/",
      { method: "POST", body: JSON.stringify(userDeletedEvent("workos_1")) },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
    expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
  });

  it("returns 401 (and logs a distinct config error, not routine auth noise) when WORKOS_WEBHOOK_SECRET is unset (#151)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request(
      "/",
      req,
      { ...TEST_ENV, WORKOS_WEBHOOK_SECRET: undefined } as unknown as Env,
    );

    expect(res.status).toBe(401);
    expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
    // #275: logServerError now emits one JSON line instead of two args.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleSpy.mock.calls[0]![0] as string) as { message: string };
    expect(logged.message).toContain("WORKOS_WEBHOOK_SECRET");

    consoleSpy.mockRestore();
  });

  it("returns 401 for a tampered signature", async () => {
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);
    req.headers["workos-signature"] = tamperSignature(req.headers["workos-signature"]);
    const res = await webhooksWorkos.request("/", req, TEST_ENV);
    expect(res.status).toBe(401);
    expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
  });

  it("returns 401 for a signature computed with the wrong secret", async () => {
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload, "whsec_wrong_secret");
    const res = await webhooksWorkos.request("/", req, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a stale timestamp (replay protection)", async () => {
    const payload = userDeletedEvent("workos_1");
    const staleTimestamp = Date.now() - 1000 * 60 * 10; // 10 minutes ago
    const req = await signedRequest(payload, WEBHOOK_SECRET, staleTimestamp);
    const res = await webhooksWorkos.request("/", req, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 400 for a body that isn't valid JSON", async () => {
    const res = await webhooksWorkos.request(
      "/",
      {
        method: "POST",
        headers: { "workos-signature": "t=1,v1=deadbeef" },
        body: "not json",
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("deactivates the user and audit-logs against every org they belonged to on a valid user.deleted event", async () => {
    deactivateByWorkosUserId.mockResolvedValue({
      userId: "user-1",
      orgScopes: ["org-a", "org-b"],
    });
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(deactivateByWorkosUserId).toHaveBeenCalledWith(expect.anything(), "workos_1");
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      expect.objectContaining({ action: "user.deprovisioned", targetType: "user", targetId: "user-1" }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "org-b",
      expect.objectContaining({ action: "user.deprovisioned", targetType: "user", targetId: "user-1" }),
    );
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "event_1", eventType: "user.deleted", status: "processed" }),
    );
  });

  it("re-emits the deprovisioning audit on a retry, even though the user is already deactivated (#151)", async () => {
    // The exact scenario #151 fixes: a first delivery deactivated the user
    // and cascaded memberships, but its audit write failed (status stayed
    // "failed", so claimWebhookEvent lets this retry through). The real
    // deactivateByWorkosUserId no longer returns null just because the
    // user is already inactive -- it recomputes org scopes so the audit
    // can actually be written this time.
    deactivateByWorkosUserId.mockResolvedValue({
      userId: "user-1",
      orgScopes: ["org-a"],
    });
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      expect.objectContaining({ action: "user.deprovisioned", targetId: "user-1" }),
    );
  });

  it("returns 200 with no-op for a workosUserId we've never seen", async () => {
    deactivateByWorkosUserId.mockResolvedValue(null);
    const payload = userDeletedEvent("workos_unknown");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(deactivateByWorkosUserId).toHaveBeenCalledWith(expect.anything(), "workos_unknown");
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("acknowledges an event type outside v0 scope with 200 instead of erroring", async () => {
    const payload = userEvent("event_2", "organization_membership.deleted");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
    expect(handleEmailUpdated).not.toHaveBeenCalled();
  });

  it("logs (not just silently acknowledges) an unhandled event type, and records it as skipped", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const payload = userEvent("event_3", "organization_membership.deleted");
    const req = await signedRequest(payload);

    await webhooksWorkos.request("/", req, TEST_ENV);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("organization_membership.deleted"));
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "skipped" }),
    );
    logSpy.mockRestore();
  });

  it("returns 500 (not 401 or a silent failure) when a verified event fails to process, and records it as failed", async () => {
    deactivateByWorkosUserId.mockRejectedValue(new Error("connection refused: ECONNREFUSED"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED/);
    expect(consoleSpy).toHaveBeenCalled();
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed" }),
    );

    consoleSpy.mockRestore();
  });

  describe("user.updated (#142, #151)", () => {
    it("re-encrypts email + refreshes the blind index via UserIdentityService", async () => {
      handleEmailUpdated.mockResolvedValue({ updated: true });
      const payload = userEvent("event_4", "user.updated", { email: "new@uw.edu" });
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);

      expect(res.status).toBe(200);
      expect(handleEmailUpdated).toHaveBeenCalledWith("workos_1", "new@uw.edu");
      expect(recordWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "event_4", eventType: "user.updated", status: "processed" }),
      );
    });

    it("returns 500 and records failed when re-encryption fails", async () => {
      handleEmailUpdated.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const payload = userEvent("event_5", "user.updated", { email: "new@uw.edu" });
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);

      expect(res.status).toBe(500);
      expect(recordWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "failed" }),
      );
      consoleSpy.mockRestore();
    });

    it("treats a missing email as skipped, not a processing failure (#151 poison-message guard)", async () => {
      const payload = userEvent("event_6", "user.updated", { email: null });
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);

      expect(res.status).toBe(200);
      expect(handleEmailUpdated).not.toHaveBeenCalled();
      expect(recordWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "event_6", status: "skipped" }),
      );
    });

    it("treats a blank email as skipped, not a processing failure (#151)", async () => {
      const payload = userEvent("event_7", "user.updated", { email: "   " });
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);

      expect(res.status).toBe(200);
      expect(handleEmailUpdated).not.toHaveBeenCalled();
      expect(recordWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "skipped" }),
      );
    });

    it("would have thrown without the guard: sanity check that IdentityCipher.normalizeEmail rejects a missing email", async () => {
      const { IdentityCipher } = await import("../../lib/crypto/identity-cipher");
      expect(() => IdentityCipher.normalizeEmail(undefined as unknown as string)).toThrow();
    });
  });

  describe("event claim / replay dedup (#95, #142, #151)", () => {
    it("skips reprocessing when claimWebhookEvent reports the event already claimed/processed", async () => {
      claimWebhookEvent.mockResolvedValue(false);
      const payload = userDeletedEvent("workos_1");
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);
      const body = (await res.json()) as { received: boolean; duplicate?: boolean };

      expect(res.status).toBe(200);
      expect(body.duplicate).toBe(true);
      expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
      expect(recordWebhookEvent).not.toHaveBeenCalled();
    });

    it("processes the event when claimWebhookEvent reports the claim won (fresh event or retry-after-failed)", async () => {
      claimWebhookEvent.mockResolvedValue(true);
      deactivateByWorkosUserId.mockResolvedValue(null);
      const payload = userDeletedEvent("workos_1");
      const req = await signedRequest(payload);

      const res = await webhooksWorkos.request("/", req, TEST_ENV);
      const body = (await res.json()) as { duplicate?: boolean };

      expect(res.status).toBe(200);
      expect(body.duplicate).toBeUndefined();
      expect(deactivateByWorkosUserId).toHaveBeenCalledWith(expect.anything(), "workos_1");
      expect(claimWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "event_1", eventType: "user.deleted" }),
      );
      expect(recordWebhookEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "processed" }),
      );
    });
  });
});
