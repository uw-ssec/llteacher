import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "../db/client";
import { fakeAuthContext, fakeMembership } from "../server/testing/authContext";
import { unsafeOrgScope } from "../server/repositories/scope";
import { AUDIT_ACTIONS } from "../server/utils/audit";

const recordAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../server/repositories/auditEvents", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));

import { canReadCourseTranscripts, recordTranscriptAccess } from "./instructor-authz";

beforeEach(() => {
  recordAuditEvent.mockReset().mockResolvedValue(undefined);
});

describe("canReadCourseTranscripts", () => {
  it("admits a grader-tier member (instructor/admin/ta) of the course", () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-a", role: "ta" })],
    });
    expect(canReadCourseTranscripts(authContext, "course-a")).toBe(true);
  });

  it("denies a caller with no membership on the course", () => {
    const authContext = fakeAuthContext({ memberships: [] });
    expect(canReadCourseTranscripts(authContext, "course-a")).toBe(false);
  });
});

// #370: recordTranscriptAccess used to return silently when orgScope
// couldn't be resolved -- a FERPA-relevant read proceeding with zero audit
// trail and zero log line. These tests pin the fix: the branch must still
// not fail the read (auditBestEffort/db is never touched), but it must now
// log loudly via logServerError with enough context to debug the race.
describe("recordTranscriptAccess", () => {
  it("logs loudly and skips the write when orgScope is null (#370)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {} as unknown as Db;

    await recordTranscriptAccess(db, null, {
      viewerId: "viewer-1",
      courseId: "course-1",
      conversationId: "conversation-1",
      action: "detail",
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [contextArg, errArg] = consoleSpy.mock.calls[0]!;
    expect(contextArg).toContain("recordTranscriptAccess");
    expect(errArg).toBeInstanceOf(Error);
    expect((errArg as Error).message).toContain("course-1");
    expect((errArg as Error).message).toContain("viewer-1");
    expect((errArg as Error).message).toContain("detail");
    expect((errArg as Error).message).toContain("conversation-1");
    // The read must not be failed for an audit-resolution hiccup: no write
    // path is invoked at all.
    expect(recordAuditEvent).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("omits conversationId from the log message for a list read with no orgScope", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {} as unknown as Db;

    await recordTranscriptAccess(db, null, {
      viewerId: "viewer-2",
      courseId: "course-2",
      action: "list",
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [, errArg] = consoleSpy.mock.calls[0]!;
    expect((errArg as Error).message).not.toContain("conversationId");

    consoleSpy.mockRestore();
  });

  it("writes a TRANSCRIPT_VIEWED audit event and does not log when orgScope resolves (detail read)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {} as unknown as Db;
    const orgScope = unsafeOrgScope("org-1");

    await recordTranscriptAccess(db, orgScope, {
      viewerId: "viewer-3",
      courseId: "course-3",
      conversationId: "conversation-3",
      action: "detail",
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      db,
      orgScope,
      expect.objectContaining({
        actorUserId: "viewer-3",
        action: AUDIT_ACTIONS.TRANSCRIPT_VIEWED,
        targetType: "conversation",
        targetId: "conversation-3",
      }),
    );

    consoleSpy.mockRestore();
  });

  it("writes a TRANSCRIPT_LIST_VIEWED audit event for a list read", async () => {
    const db = {} as unknown as Db;
    const orgScope = unsafeOrgScope("org-1");

    await recordTranscriptAccess(db, orgScope, {
      viewerId: "viewer-4",
      courseId: "course-4",
      action: "list",
    });

    expect(recordAuditEvent).toHaveBeenCalledWith(
      db,
      orgScope,
      expect.objectContaining({
        actorUserId: "viewer-4",
        action: AUDIT_ACTIONS.TRANSCRIPT_LIST_VIEWED,
        targetType: "course",
        targetId: "course-4",
      }),
    );
  });
});
