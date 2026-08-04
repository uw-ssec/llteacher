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

const deactivateByWorkosUserId = vi.fn();
vi.mock("../repositories/users", () => ({
  deactivateByWorkosUserId: (...args: unknown[]) => deactivateByWorkosUserId(...args),
}));

const recordAuditEvent = vi.fn();
vi.mock("../repositories/auditEvents", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
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

function userDeletedEvent(workosUserId: string) {
  return {
    id: "event_1",
    event: "user.deleted",
    createdAt: new Date().toISOString(),
    data: {
      object: "user",
      id: workosUserId,
      email: "deleted@uw.edu",
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
    },
  };
}

beforeEach(() => {
  deactivateByWorkosUserId.mockReset();
  recordAuditEvent.mockReset();
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

  it("returns 401 for a tampered signature", async () => {
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);
    req.headers["workos-signature"] = req.headers["workos-signature"].replace(/.$/, "0");
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
  });

  it("is idempotent: a duplicate delivery for an already-deactivated user is a 200 no-op with no audit write", async () => {
    deactivateByWorkosUserId.mockResolvedValue(null);
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("returns 200 with no-op for a workosUserId we've never seen", async () => {
    deactivateByWorkosUserId.mockResolvedValue(null);
    const payload = userDeletedEvent("workos_unknown");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(deactivateByWorkosUserId).toHaveBeenCalledWith(expect.anything(), "workos_unknown");
  });

  it("acknowledges an event type outside v0 scope with 200 instead of erroring", async () => {
    const payload = {
      id: "event_2",
      event: "user.updated",
      createdAt: new Date().toISOString(),
      data: userDeletedEvent("workos_1").data,
    };
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(200);
    expect(deactivateByWorkosUserId).not.toHaveBeenCalled();
  });

  it("returns 500 (not 401 or a silent failure) when a verified event fails to process", async () => {
    deactivateByWorkosUserId.mockRejectedValue(new Error("connection refused: ECONNREFUSED"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = userDeletedEvent("workos_1");
    const req = await signedRequest(payload);

    const res = await webhooksWorkos.request("/", req, TEST_ENV);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED/);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
