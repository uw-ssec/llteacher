/* --------------------------------------------------------------------------
   #74: the roster sync's three-pass diff, against a real database.

   Real-DB, for the same reason roster.test.ts is: this service's whole
   point is DB behaviour (course_memberships_user_course_uq, the pending-
   user reconciliation upsertCourseMembers performs, an UPDATE actually
   sticking) that a mocked db would not exercise. The Canvas HTTP layer
   (lib/canvas-api.ts) is mocked -- there is no live Canvas to sync
   against in CI -- so this suite gets both: real write semantics, and a
   controlled, scriptable enrollment feed per test.
   -------------------------------------------------------------------------- */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { unsafeCourseScope } from "../../server/repositories/scope";
import { loadIdentityCipherKeys } from "../secrets-loader";
import { IdentityCipher } from "../crypto/identity-cipher";
import type { CanvasEnrollment } from "../canvas-api";

vi.mock("../canvas-api", async () => {
  const actual = await vi.importActual<typeof import("../canvas-api")>("../canvas-api");
  return { ...actual, listCanvasEnrollments: vi.fn() };
});
import { listCanvasEnrollments } from "../canvas-api";
import { syncCanvasRoster } from "./CanvasRosterSyncService";

const listCanvasEnrollmentsMock = vi.mocked(listCanvasEnrollments);

/** courseMemberships.canvasEnrollmentId is globally unique (it mirrors a
 *  real Canvas instance, where enrollment ids are unique platform-wide,
 *  not per-course) -- so two independent tests both writing a literal
 *  "e1" collide for real against the same constraint production relies
 *  on. Each test gets its own namespace via `enrollmentFactory()` below;
 *  within one test, calling it with the same logical id ("e1") twice
 *  (e.g. across a re-sync) still refers to the same enrollment. */
function enrollmentFactory() {
  const ns = crypto.randomUUID().slice(0, 8);
  return (
    localId: string,
    overrides: Partial<CanvasEnrollment> = {},
  ): CanvasEnrollment => {
    const canvasEnrollmentId = `${ns}-${localId}`;
    return {
      canvasEnrollmentId,
      type: "StudentEnrollment",
      enrollmentState: "active",
      userId: `canvas-user-${canvasEnrollmentId}`,
      email: `${ns}-${localId}@uw.edu`,
      name: `Person ${localId}`,
      ...overrides,
    };
  };
}

const DATABASE_URL = process.env.DATABASE_URL;
const CREDENTIAL = { token: "fake-token", canvasBaseUrl: "https://uw.instructure.com" };

describe.skipIf(!DATABASE_URL)("syncCanvasRoster (#74)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `csync-${crypto.randomUUID()}`,
        name: "Canvas sync org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
        allowedDomains: ["uw.edu"],
      })
      .returning({ id: organizations.id });
    orgId = org!.id;
  });

  beforeEach(() => {
    listCanvasEnrollmentsMock.mockReset();
  });

  async function newCourse(): Promise<ReturnType<typeof unsafeCourseScope>> {
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: `C-${crypto.randomUUID().slice(0, 6)}`, term: "T", title: "Sync course" })
      .returning({ id: courses.id });
    return unsafeCourseScope(course!.id);
  }

  async function membershipsFor(scope: ReturnType<typeof unsafeCourseScope>) {
    return db
      .select()
      .from(courseMemberships)
      .innerJoin(users, eq(courseMemberships.userId, users.id))
      .where(eq(courseMemberships.courseId, scope));
  }

  it("creates pending users and memberships for a course's first sync", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const e1 = enrollment("e1", { type: "TeacherEnrollment" });
    const e2 = enrollment("e2", { type: "StudentEnrollment" });
    const e3 = enrollment("e3", { type: "TaEnrollment" });
    listCanvasEnrollmentsMock.mockResolvedValue([e1, e2, e3]);

    const result = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(result).toEqual({ added: 3, updated: 0, removed: 0, errors: [] });
    const rows = await membershipsFor(scope);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.users.isPending)).toBe(true);
    const byCanvasId = new Map(rows.map((r) => [r.course_memberships.canvasEnrollmentId, r.course_memberships]));
    expect(byCanvasId.get(e1.canvasEnrollmentId)!.role).toBe("instructor");
    expect(byCanvasId.get(e2.canvasEnrollmentId)!.role).toBe("student");
    expect(byCanvasId.get(e3.canvasEnrollmentId)!.role).toBe("ta");
  });

  it("is idempotent -- re-syncing identical enrollments reports zero adds", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    listCanvasEnrollmentsMock.mockResolvedValue([enrollment("e1")]);

    await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);
    const second = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.removed).toBe(0);
    const rows = await membershipsFor(scope);
    expect(rows).toHaveLength(1);
  });

  it("maps a Canvas role change on an already-synced enrollment", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1", { type: "StudentEnrollment" })]);
    await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1", { type: "TaEnrollment" })]);
    const second = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(second).toEqual({ added: 0, updated: 1, removed: 0, errors: [] });
    const rows = await membershipsFor(scope);
    expect(rows[0]!.course_memberships.role).toBe("ta");
    expect(rows[0]!.course_memberships.canvasRole).toBe("TaEnrollment");
  });

  it("soft-drops a membership no longer present in a re-sync, without deleting the row", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const e2 = enrollment("e2");
    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1"), e2]);
    await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1")]);
    const second = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(second).toEqual({ added: 0, updated: 1, removed: 1, errors: [] });
    const rows = await membershipsFor(scope);
    expect(rows).toHaveLength(2);
    const dropped = rows.find((r) => r.course_memberships.canvasEnrollmentId === e2.canvasEnrollmentId)!;
    expect(dropped.course_memberships.droppedAt).not.toBeNull();
    expect(dropped.course_memberships.droppedReason).toBe("roster_removal");
  });

  it("restores a membership this sync previously dropped, if Canvas lists it again", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const e2 = enrollment("e2");
    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1"), e2]);
    await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);
    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1")]);
    await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    listCanvasEnrollmentsMock.mockResolvedValueOnce([enrollment("e1"), e2]);
    const third = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(third.removed).toBe(0);
    const rows = await membershipsFor(scope);
    const restored = rows.find((r) => r.course_memberships.canvasEnrollmentId === e2.canvasEnrollmentId)!;
    expect(restored.course_memberships.droppedAt).toBeNull();
  });

  it("does not delete or leave orphaned a manually added member Canvas has never listed", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const manualEmail = `manual-${crypto.randomUUID().slice(0, 8)}@uw.edu`;
    const emailBlindIndex = await cipher.computeBlindIndex(manualEmail);
    const [manualUser] = await db
      .insert(users)
      .values({ email: await cipher.encryptString(manualEmail), emailBlindIndex, isPending: true })
      .returning({ id: users.id });
    await db.insert(courseMemberships).values({ userId: manualUser!.id, courseId: scope, role: "observer" });

    listCanvasEnrollmentsMock.mockResolvedValue([enrollment("e1")]);
    const result = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(result.removed).toBe(0);
    const rows = await membershipsFor(scope);
    const manual = rows.find((r) => r.users.id === manualUser!.id)!;
    expect(manual.course_memberships.droppedAt).toBeNull();
  });

  it("reports (not auto-resolves) a role conflict against a manually added active member", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const manualEmail = `conflict-${crypto.randomUUID().slice(0, 8)}@uw.edu`;
    const emailBlindIndex = await cipher.computeBlindIndex(manualEmail);
    const [manualUser] = await db
      .insert(users)
      .values({ email: await cipher.encryptString(manualEmail), emailBlindIndex, isPending: true })
      .returning({ id: users.id });
    await db.insert(courseMemberships).values({ userId: manualUser!.id, courseId: scope, role: "observer" });

    const e1 = enrollment("e1", { email: manualEmail, type: "StudentEnrollment" });
    listCanvasEnrollmentsMock.mockResolvedValue([e1]);
    const result = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(result.added).toBe(0);
    expect(result.errors).toEqual([{ canvasEnrollmentId: e1.canvasEnrollmentId, message: expect.any(String) }]);
    const rows = await membershipsFor(scope);
    // Untouched: still the manually chosen role, not silently promoted.
    expect(rows.find((r) => r.users.id === manualUser!.id)!.course_memberships.role).toBe("observer");
  });

  it("maps DesignerEnrollment to instructor and skips an unrecognized type without failing the sync", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const e2 = enrollment("e2", { type: "SomeFutureCanvasRole" });
    listCanvasEnrollmentsMock.mockResolvedValue([enrollment("e1", { type: "DesignerEnrollment" }), e2]);

    const result = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(result.added).toBe(1);
    expect(result.errors).toEqual([{ canvasEnrollmentId: e2.canvasEnrollmentId, message: expect.any(String) }]);
    const rows = await membershipsFor(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.course_memberships.role).toBe("instructor");
  });

  it("skips an enrollment with no email without failing the sync", async () => {
    const scope = await newCourse();
    const enrollment = enrollmentFactory();
    const e1 = enrollment("e1", { email: null });
    listCanvasEnrollmentsMock.mockResolvedValue([e1]);

    const result = await syncCanvasRoster(db, cipher, scope, "canvas-1", CREDENTIAL);

    expect(result).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
      errors: [{ canvasEnrollmentId: e1.canvasEnrollmentId, message: expect.any(String) }],
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
  });
});
