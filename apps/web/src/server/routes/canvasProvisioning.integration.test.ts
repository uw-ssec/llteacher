/* --------------------------------------------------------------------------
   #73/#74, end to end: an instructor's Canvas token through to a real
   database roster, and the reconciliation half that "provisions" a synced
   student the moment they first sign in.

   Why this file and not the per-route unit suites. canvasCredentials.test.ts
   and canvasSync.test.ts each mock the layer directly below the route --
   necessary to pin the request contract in isolation, not sufficient to
   prove the pieces actually fit together against a real database. This
   drives the REAL route handlers, the REAL repositories, and the REAL
   IdentityCipher (so a token round-trips through actual AES-256-GCM, not a
   mocked encrypt/decrypt pair) against a local Postgres. Only the Canvas
   HTTP boundary is substituted -- no live Canvas account was available for
   this pass, matching the fidelity posture chat.fallback.integration.test.ts
   documents for its own single substituted boundary.

   What "provisioned in WorkOS" actually means in this codebase (Design
   decision #3, docs/superpowers/plans/2026-09-10-m11-canvas-integration.md):
   NOTHING here calls the WorkOS API to push-create an account. A sync
   creates a PENDING users row (isPending=true, no workosUserId) --
   `grep -rn "getWorkOS" lib/services/CanvasRosterSyncService.ts
   repositories/roster.ts` returns nothing, by construction. The row becomes
   a real WorkOS-backed account only when that person actually signs in
   through AuthKit and UserIdentityService.createOrClaimUser reconciles it by
   email_blind_index -- the exact mechanism manual/CSV/NetID roster entry
   already relies on. This suite proves both halves: the sync creates a
   correctly-shaped pending row, and a subsequent real login (simulated here
   by calling createOrClaimUser directly with a WorkOS-profile-shaped input,
   the same call site auth.ts's real callback handler makes after an actual
   OAuth exchange) claims it.

   Every id/email/workosUserId fixture below is namespaced by a fresh UUID
   generated at module load (`NS`). Not cosmetic: courseMemberships.
   canvasEnrollmentId, users.email_blind_index and users.workos_user_id are
   all GLOBALLY unique (mirroring real Canvas/WorkOS/email identifiers, not
   scoped to this test's own org), and this file's local Postgres is
   persistent across runs, not reset per invocation. An early version of
   this file used un-namespaced literals ("enr-teacher-1",
   "workos-user-ada-real-login") and, across repeated manual runs, collided
   with rows a PREVIOUS run had left behind -- encrypted under that other
   run's own random key. Decrypting a stale row under this run's key then
   fails exactly the way a wrong key should: a genuine AES-GCM auth-tag
   mismatch, surfaced as a generic WebCrypto "Cipher job failed". A real
   finding about test hygiene, not about the product code, which is why
   it's recorded here rather than silently fixed and forgotten. -------------------------------------------------------------------------- */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { auditEvents, courseMemberships, courses, organizationCredentials, organizations, users } from "../../db/schema";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { UserIdentityService } from "../../lib/services/UserIdentityService";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CanvasCourseSummary, CanvasEnrollment, CanvasTokenValidation } from "../../lib/canvas-api";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

import {
  getCanvasCredentialHandler,
  setCanvasCredentialHandler,
  validateCanvasCredentialHandler,
} from "./canvasCredentials";
import {
  getCanvasSyncStatusHandler,
  linkCanvasCourseHandler,
  listCanvasCoursesHandler,
  syncCanvasCourseHandler,
} from "./canvasSync";

const DATABASE_URL = process.env.DATABASE_URL;

// The one substituted boundary: no live Canvas account in this environment.
// Every other layer below the route handlers (db, cipher, repositories,
// the sync service) is real.
const validateCanvasTokenMock = vi.fn<() => Promise<CanvasTokenValidation>>();
const listCanvasCoursesMock = vi.fn<() => Promise<CanvasCourseSummary[]>>();
const listCanvasEnrollmentsMock = vi.fn<() => Promise<CanvasEnrollment[]>>();
vi.mock("../../lib/canvas-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/canvas-api")>()),
  validateCanvasToken: (...a: Parameters<typeof validateCanvasTokenMock>) => validateCanvasTokenMock(...a),
  listCanvasCourses: (...a: Parameters<typeof listCanvasCoursesMock>) => listCanvasCoursesMock(...a),
  listCanvasEnrollments: (...a: Parameters<typeof listCanvasEnrollmentsMock>) => listCanvasEnrollmentsMock(...a),
}));

// makeDb() in production speaks Neon's HTTP-only protocol and cannot reach
// a plain Postgres server (see nodeClient.ts's own header comment). Route
// handlers call makeDb() internally and cannot be redirected per-call, so
// this substitutes it at the module boundary for the one real (Node,
// TCP) connection every assertion in this file also queries through --
// same trick hello.test.ts uses to stub makeDb, pointed at something real
// instead of `{}`.
let realDb: Db;
vi.mock("../../db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/client")>()),
  makeDb: () => realDb,
}));

const TEST_ENV = {
  DATABASE_URL: "unused-see-mock-above",
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;

function buildApp(authContext: AuthContext) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/canvas";
  app.get(`${base}/credential`, (c) => getCanvasCredentialHandler(c));
  app.put(`${base}/credential`, (c) => setCanvasCredentialHandler(c));
  app.post(`${base}/credential/validate`, (c) => validateCanvasCredentialHandler(c));
  app.get(`${base}/courses`, (c) => listCanvasCoursesHandler(c));
  app.get(`${base}/status`, (c) => getCanvasSyncStatusHandler(c));
  app.put(`${base}/link`, (c) => linkCanvasCourseHandler(c));
  app.post(`${base}/sync`, (c) => syncCanvasCourseHandler(c));
  return app;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// See the module header: every identifier below is namespaced by NS so
// repeated manual runs against this file's persistent local Postgres
// never collide with a previous run's leftover rows.
const NS = crypto.randomUUID().slice(0, 8);
const CANVAS_COURSE_ID = `canvas-course-${NS}`;

// A realistic Canvas roster: an instructor (already the caller, teacher-
// testing the flow), two students, and one enrollment with no email --
// Canvas genuinely produces these (a not-yet-fully-provisioned SIS user) --
// to prove one bad row doesn't fail the batch.
const ENROLLMENTS: CanvasEnrollment[] = [
  {
    canvasEnrollmentId: `${NS}-enr-teacher-1`,
    type: "TeacherEnrollment",
    enrollmentState: "active",
    userId: "canvas-user-1",
    email: `lauren.instructor-${NS}@uw.edu`,
    name: "Lauren Instructor",
  },
  {
    canvasEnrollmentId: `${NS}-enr-student-1`,
    type: "StudentEnrollment",
    enrollmentState: "active",
    userId: "canvas-user-2",
    email: `ada.lovelace-${NS}@uw.edu`,
    name: "Ada Lovelace",
  },
  {
    canvasEnrollmentId: `${NS}-enr-student-2`,
    type: "StudentEnrollment",
    enrollmentState: "active",
    userId: "canvas-user-3",
    email: `grace.hopper-${NS}@uw.edu`,
    name: "Grace Hopper",
  },
  {
    canvasEnrollmentId: `${NS}-enr-no-email`,
    type: "StudentEnrollment",
    enrollmentState: "active",
    userId: "canvas-user-4",
    email: null,
    name: null,
  },
];

describe.skipIf(!DATABASE_URL)(
  "Canvas provisioning, end to end: token -> validate -> link -> sync -> pending users -> WorkOS reconciliation",
  () => {
    let db: Db;
    let cipher: IdentityCipher;
    let orgId: string;
    let courseId: string;
    let authContext: AuthContext;

    beforeAll(async () => {
      db = makeNodeDb(DATABASE_URL!);
      realDb = db;
      cipher = new IdentityCipher(await loadIdentityCipherKeys(TEST_ENV));

      const [org] = await db
        .insert(organizations)
        .values({
          slug: `canvas-e2e-${NS}`,
          name: "Canvas E2E Org",
          workosOrganizationId: `w-org-${NS}`,
          allowedDomains: ["uw.edu"],
        })
        .returning({ id: organizations.id });
      orgId = org!.id;

      const [course] = await db
        .insert(courses)
        .values({ organizationId: orgId, code: "E2E 101", term: "Fall 2026", title: "Canvas E2E Course" })
        .returning({ id: courses.id });
      courseId = course!.id;

      // A real users row, not just a UUID label: audit_events.actor_user_id
      // has a foreign key onto users.id. In production this row exists
      // because the instructor themselves already logged in via WorkOS.
      const [instructor] = await db
        .insert(users)
        .values({
          workosUserId: `w-instructor-${NS}`,
          email: await cipher.encryptString(`instructor-${NS}@uw.edu`),
          emailBlindIndex: await cipher.computeBlindIndex(`instructor-${NS}@uw.edu`),
          isPending: false,
        })
        .returning({ id: users.id });
      const instructorUserId = instructor!.id;
      authContext = fakeAuthContext({
        session: { userId: instructorUserId, workosUserId: `w-instructor-${NS}`, sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
        memberships: [fakeMembership({ courseId, role: "instructor" })],
      });
    });

    afterAll(async () => {
      vi.restoreAllMocks();
    });

    it("runs the whole instructor-facing flow and provisions a correct, encrypted-at-rest roster", async () => {
      const app = buildApp(authContext);
      const url = (suffix: string) => `/api/courses/${courseId}/canvas${suffix}`;

      /* ---- Step 1: instructor saves their Canvas token ---- */
      const RAW_TOKEN = `canvas-token-${NS}`;
      const saveRes = await app.request(
        url("/credential"),
        json("PUT", { token: RAW_TOKEN, canvasBaseUrl: "https://uw.instructure.com" }),
        TEST_ENV,
      );
      expect(saveRes.status).toBe(200);
      const saveBodyText = await saveRes.text();
      // The single most important property in this whole file: the raw
      // token never appears in an HTTP response, anywhere.
      expect(saveBodyText).not.toContain(RAW_TOKEN);
      const saved = JSON.parse(saveBodyText) as { credential: { maskedToken: string } };
      expect(saved.credential.maskedToken).toBe(`${RAW_TOKEN.slice(0, 2)}••••${RAW_TOKEN.slice(-2)}`);

      // Independently confirm the encryption actually happened, by reading
      // straight off the table and decrypting with the real cipher --
      // not through any route this suite is also asserting on.
      const [credentialRow] = await db
        .select()
        .from(organizationCredentials)
        .where(
          and(
            eq(organizationCredentials.organizationId, orgId),
            eq(organizationCredentials.provider, "canvas"),
          ),
        );
      expect(credentialRow).toBeDefined();
      expect(credentialRow!.encryptedSecret).not.toBeNull();
      const decryptedToken = await cipher.decryptString(credentialRow!.encryptedSecret!);
      expect(decryptedToken).toBe(RAW_TOKEN);

      /* ---- Step 2: validate ---- */
      validateCanvasTokenMock.mockResolvedValue({ ok: true, canvasUserId: "1", name: "Lauren Instructor" });
      const validateRes = await app.request(url("/credential/validate"), { method: "POST" }, TEST_ENV);
      expect(validateRes.status).toBe(200);
      expect(await validateRes.json()).toEqual({ ok: true, canvasUserId: "1", name: "Lauren Instructor" });

      /* ---- Step 3: course picker ---- */
      listCanvasCoursesMock.mockResolvedValue([
        { canvasCourseId: CANVAS_COURSE_ID, name: "E2E 101", courseCode: "E2E 101 A", term: "Fall 2026" },
      ]);
      const coursesRes = await app.request(url("/courses"), {}, TEST_ENV);
      expect(coursesRes.status).toBe(200);
      const coursesBody = (await coursesRes.json()) as { courses: CanvasCourseSummary[] };
      expect(coursesBody.courses).toHaveLength(1);

      /* ---- Step 4: link ---- */
      const linkRes = await app.request(url("/link"), json("PUT", { canvasCourseId: CANVAS_COURSE_ID }), TEST_ENV);
      expect(linkRes.status).toBe(200);
      expect((await linkRes.json()) as { canvasCourseId: string }).toMatchObject({
        canvasCourseId: CANVAS_COURSE_ID,
      });
      const [linkedCourse] = await db.select().from(courses).where(eq(courses.id, courseId));
      expect(linkedCourse!.canvasCourseId).toBe(CANVAS_COURSE_ID);

      /* ---- Step 5: sync -- pulls real (mocked-boundary) enrollments,
         writes real rows through the real sync service and the real
         roster.ts provisioning pipeline. ---- */
      listCanvasEnrollmentsMock.mockResolvedValue(ENROLLMENTS);
      const syncRes = await app.request(url("/sync"), { method: "POST" }, TEST_ENV);
      expect(syncRes.status).toBe(200);
      const syncBody = (await syncRes.json()) as {
        added: number;
        updated: number;
        removed: number;
        errors: { canvasEnrollmentId: string; message: string }[];
      };
      // 3 of 4 enrollments are provisionable; the no-email row is reported,
      // not silently dropped and not fatal to the other three.
      expect(syncBody.added).toBe(3);
      expect(syncBody.removed).toBe(0);
      expect(syncBody.errors).toEqual([
        { canvasEnrollmentId: `${NS}-enr-no-email`, message: expect.stringMatching(/email/i) },
      ]);

      /* ---- Verify the actual database state: this is the "students
         provisioned with name/email + course memberships" the user
         asked to see proven. ---- */
      const rows = await db
        .select()
        .from(courseMemberships)
        .innerJoin(users, eq(courseMemberships.userId, users.id))
        .where(eq(courseMemberships.courseId, courseId));
      expect(rows).toHaveLength(3);

      const byCanvasId = new Map(rows.map((r) => [r.course_memberships.canvasEnrollmentId, r]));
      for (const enrollment of [ENROLLMENTS[0]!, ENROLLMENTS[1]!, ENROLLMENTS[2]!]) {
        const row = byCanvasId.get(enrollment.canvasEnrollmentId);
        expect(row, `expected a row for ${enrollment.canvasEnrollmentId}`).toBeDefined();
        // PII is stored encrypted -- decrypt with the real cipher and
        // confirm it matches Canvas's own data exactly, not a placeholder.
        const decryptedEmail = await cipher.decryptString(row!.users.email);
        const decryptedName = row!.users.displayName ? await cipher.decryptString(row!.users.displayName) : null;
        expect(decryptedEmail).toBe(enrollment.email);
        expect(decryptedName).toBe(enrollment.name);
        expect(row!.users.isPending).toBe(true);
        expect(row!.users.workosUserId).toBeNull();
        expect(row!.course_memberships.canvasRole).toBe(enrollment.type);
      }
      expect(byCanvasId.get(`${NS}-enr-teacher-1`)!.course_memberships.role).toBe("instructor");
      expect(byCanvasId.get(`${NS}-enr-student-1`)!.course_memberships.role).toBe("student");
      expect(byCanvasId.get(`${NS}-enr-student-2`)!.course_memberships.role).toBe("student");

      /* ---- Sync status + audit trail ---- */
      const statusRes = await app.request(url("/status"), {}, TEST_ENV);
      const status = (await statusRes.json()) as { lastSyncStatus: string; lastSyncCounts: unknown };
      expect(status.lastSyncStatus).toBe("success");
      expect(status.lastSyncCounts).toEqual({ added: 3, updated: 0, removed: 0 });

      const events = await db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
      const actions = events.map((e) => e.action).sort();
      expect(actions).toEqual(
        [
          "credential.canvas_token_set",
          "credential.canvas_token_validated",
          "lms_integration.canvas_course_linked",
          "lms_integration.canvas_sync_completed",
        ].sort(),
      );

      /* ---- Step 6: the WorkOS half. No API call happened above -- prove
         the pending row is real and reconciles correctly on an actual
         first login, the same call auth.ts's callback handler makes. ---- */
      const adaBefore = byCanvasId.get(`${NS}-enr-student-1`)!.users;
      expect(adaBefore.isPending).toBe(true);

      const identityService = new UserIdentityService(cipher, db);
      const claimed = await identityService.createOrClaimUser({
        id: `workos-user-ada-${NS}`,
        email: `ada.lovelace-${NS}@uw.edu`,
        firstName: "Ada",
      });
      expect(claimed.isNew).toBe(false); // claimed the EXISTING pending row, not a fresh insert
      expect(claimed.userId).toBe(adaBefore.id);

      const [adaAfter] = await db.select().from(users).where(eq(users.id, adaBefore.id));
      expect(adaAfter!.isPending).toBe(false);
      expect(adaAfter!.workosUserId).toBe(`workos-user-ada-${NS}`);
      expect(adaAfter!.isActive).toBe(true);

      // Her course membership is untouched by the login -- same row,
      // same role, still pointing at the same Canvas enrollment.
      const [adaMembership] = await db
        .select()
        .from(courseMemberships)
        .where(and(eq(courseMemberships.userId, adaBefore.id), eq(courseMemberships.courseId, courseId)));
      expect(adaMembership!.canvasEnrollmentId).toBe(`${NS}-enr-student-1`);
      expect(adaMembership!.role).toBe("student");

      /* ---- Idempotency: re-running the sync with the same roster changes
         nothing, proving a second "provisioning" pass is safe. ---- */
      const secondSyncRes = await app.request(url("/sync"), { method: "POST" }, TEST_ENV);
      const secondSyncBody = (await secondSyncRes.json()) as { added: number; updated: number; removed: number };
      expect(secondSyncBody).toMatchObject({ added: 0, removed: 0 });
    });
  },
);
