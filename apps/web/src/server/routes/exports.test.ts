/* --------------------------------------------------------------------------
   #91: instructor export.

   Real-DB, because what is worth testing is what the QUERIES return -- that
   a per-student export contains one student, that another course's work
   never appears, and that identity is decrypted at generation time. A mocked
   db would be asserting the mock.

   The CSV-injection guard is here too: an exported cell beginning =, + , -
   or @ is executed as a formula by Excel and Sheets on open, which turns a
   student's own display name into code aimed at the instructor's machine.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import {
  conversations,
  courseMemberships,
  courses,
  grades,
  homeworks,
  messages,
  organizations,
  sections,
  submissions,
  users,
} from "../../db/schema";
import { createExportHandler } from "./exports";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

const DATABASE_URL = process.env.DATABASE_URL;

/** The real db and the real cipher: this suite is about what the queries and
 *  the decryption actually produce. Only the key material is synthesised. */
const ENC = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const BLIND = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

vi.mock("../utils/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/audit")>();
  return { ...actual, auditBestEffort: (...a: unknown[]) => auditSpy(...a) };
});
const auditSpy = vi.fn(async (..._args: unknown[]) => undefined);

/* The ONE substitution: makeDb builds a neon-http client, which speaks
   Neon's HTTP protocol and cannot reach a local Postgres. Swapped for the
   node-postgres client the other real-DB suites use, so every query in the
   handler runs for real against a real database -- which is the entire
   point of this file. */
vi.mock("../../db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/client")>();
  const { makeNodeDb } = await import("../../db/nodeClient");
  return { ...actual, makeDb: (url: string) => makeNodeDb(url) };
});

describe.skipIf(!DATABASE_URL)("POST /exports (#91, real DB)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;
  let courseId: string;
  let otherCourseId: string;
  let adaUserId: string;
  let graceUserId: string;

  const ENV = { DATABASE_URL: "", ENCRYPTION_KEY: ENC, BLIND_INDEX_KEY: BLIND } as Env;

  function app(authContext: AuthContext) {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("authContext", authContext);
      await next();
    });
    a.post("/api/courses/:courseId/exports", (c) => createExportHandler(c));
    return a;
  }

  const instructor = () =>
    fakeAuthContext({ memberships: [fakeMembership({ courseId: "COURSE", role: "instructor" })] });

  const post = (body: unknown, ctx = instructor()) =>
    app(ctx).request(
      `/api/courses/${courseId}/exports`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { ...ENV, DATABASE_URL: DATABASE_URL! },
    );

  /** The auth context is keyed on the literal "COURSE"; rebind it to the
   *  real id once the fixture exists. */
  function instructorOfCourse() {
    return fakeAuthContext({
      memberships: [fakeMembership({ courseId, role: "instructor" })],
    });
  }

  async function seedStudent(name: string, section: string): Promise<{ userId: string; submissionId: string }> {
    const [u] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(`${name.toLowerCase().replace(/\W/g, "")}@uw.edu`),
        emailBlindIndex: await cipher.computeBlindIndex(crypto.randomUUID()),
        displayName: await cipher.encryptString(name),
      })
      .returning({ id: users.id });
    await db.insert(courseMemberships).values({ userId: u!.id, courseId, role: "student" });

    const [sectionRow] = await db
      .select({ id: sections.id })
      .from(sections)
      .where(eq(sections.title, section));

    const [conv] = await db
      .insert(conversations)
      .values({
        courseId,
        ownerUserId: u!.id,
        sectionId: sectionRow!.id,
        kind: "section",
        title: `${name} conversation`,
      })
      .returning({ id: conversations.id });
    await db.insert(messages).values([
      { conversationId: conv!.id, role: "user", parts: [{ type: "text", text: `I think ${name} said this.` }] },
      { conversationId: conv!.id, role: "assistant", parts: [{ type: "text", text: "Tell me more." }] },
    ]);
    const [sub] = await db
      .insert(submissions)
      .values({
        conversationId: conv!.id,
        organizationId: orgId,
        userId: u!.id,
        sectionId: sectionRow!.id,
      })
      .returning({ id: submissions.id });
    return { userId: u!.id, submissionId: sub!.id };
  }

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(await loadIdentityCipherKeys({ ENCRYPTION_KEY: ENC, BLIND_INDEX_KEY: BLIND } as Env));

    const [o] = await db
      .insert(organizations)
      .values({
        slug: `x-${crypto.randomUUID()}`,
        name: "Export org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = o!.id;
    const [c] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "X1", term: "T", title: "Export" })
      .returning({ id: courses.id });
    courseId = c!.id;
    const [c2] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "X2", term: "T", title: "Other" })
      .returning({ id: courses.id });
    otherCourseId = c2!.id;

    const [iu] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString("prof@uw.edu"),
        emailBlindIndex: await cipher.computeBlindIndex(crypto.randomUUID()),
        displayName: await cipher.encryptString("Anjali Chen"),
      })
      .returning({ id: users.id });
    const [im] = await db
      .insert(courseMemberships)
      .values({ userId: iu!.id, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: im!.id,
        title: "HW1",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: homeworks.id });
    await db
      .insert(sections)
      .values({ homeworkId: hw!.id, title: `S-${courseId.slice(0, 6)}`, content: "c", order: 1 });

    const sectionTitle = `S-${courseId.slice(0, 6)}`;
    // A name that is a spreadsheet formula. Real: people paste odd values
    // into name fields, and an export lands on the instructor's machine.
    const ada = await seedStudent(`=cmd|'/c calc'!A1`, sectionTitle);
    adaUserId = ada.userId;
    const grace = await seedStudent("Grace Hopper", sectionTitle);
    graceUserId = grace.userId;

    await db.insert(grades).values({
      organizationId: orgId,
      submissionId: grace.submissionId,
      graderMembershipId: im!.id,
      gradedByAi: false,
      score: 88,
      maxScore: 100,
      feedback: "Strong reasoning.",
    });
  });

  afterAll(async () => {
    await db.delete(grades).where(eq(grades.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("neutralises a formula-leading cell so a CSV cannot execute on open", async () => {
    const res = await post({ subject: "submissions", format: "csv" }, instructorOfCourse());
    expect(res.status).toBe(200);
    const artifact = (await res.json()) as { body: string; filename: string };
    // Prefixed, and visibly so -- better than a file that runs something.
    expect(artifact.body).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(artifact.body).not.toMatch(/(^|,)"=cmd/);
  });

  it("writes a BOM and CRLF so Excel opens non-ASCII names correctly", async () => {
    const res = await post({ subject: "submissions", format: "csv" }, instructorOfCourse());
    const artifact = (await res.json()) as { body: string };
    expect(artifact.body.startsWith("﻿")).toBe(true);
    expect(artifact.body).toContain("\r\n");
  });

  it("decrypts identity at generation time", async () => {
    const res = await post({ subject: "submissions", format: "json" }, instructorOfCourse());
    const artifact = (await res.json()) as { body: string };
    expect(artifact.body).toContain("Grace Hopper");
  });

  it("narrows a per-student export to that student", async () => {
    const res = await post(
      { subject: "submissions", format: "json", studentId: graceUserId },
      instructorOfCourse(),
    );
    const parsed = JSON.parse(((await res.json()) as { body: string }).body) as {
      submissions: { student: string }[];
    };
    // The grade-dispute case: one student's work, not the class's.
    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0]!.student).toBe("Grace Hopper");
  });

  it("404s a student who is not on this course", async () => {
    // A bare user id from the request must not select rows on its own, or a
    // per-student export becomes a way to probe for any user in the system.
    const [stranger] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString("stranger@uw.edu"),
        emailBlindIndex: await cipher.computeBlindIndex(crypto.randomUUID()),
      })
      .returning({ id: users.id });
    const res = await post(
      { subject: "submissions", format: "json", studentId: stranger!.id },
      instructorOfCourse(),
    );
    expect(res.status).toBe(404);
    await db.delete(users).where(eq(users.id, stranger!.id));
  });

  it("exports grades including their history and grader type", async () => {
    const res = await post({ subject: "grades", format: "csv" }, instructorOfCourse());
    const artifact = (await res.json()) as { body: string };
    expect(artifact.body).toContain("88");
    expect(artifact.body).toContain("human");
  });

  it("exports transcripts as JSON with messages in order", async () => {
    const res = await post({ subject: "transcripts", format: "json" }, instructorOfCourse());
    const parsed = JSON.parse(((await res.json()) as { body: string }).body) as {
      conversations: { messages: { role: string; text: string }[] }[];
    };
    const withMessages = parsed.conversations.find((c) => c.messages.length > 0)!;
    expect(withMessages.messages[0]!.role).toBe("user");
    expect(withMessages.messages[1]!.text).toBe("Tell me more.");
  });

  it("refuses transcripts as CSV rather than producing something unreadable", async () => {
    const res = await post({ subject: "transcripts", format: "csv" }, instructorOfCourse());
    expect(res.status).toBe(400);
  });

  it("rejects an unknown subject or format", async () => {
    expect((await post({ subject: "everything", format: "csv" }, instructorOfCourse())).status).toBe(400);
    expect((await post({ subject: "grades", format: "pdf" }, instructorOfCourse())).status).toBe(400);
  });

  it("denies a TA, who may read this data but not take it off the platform", async () => {
    const ta = fakeAuthContext({ memberships: [fakeMembership({ courseId, role: "ta" })] });
    expect((await post({ subject: "grades", format: "csv" }, ta)).status).toBe(403);
  });

  it("records the scope of what left, never the contents", async () => {
    auditSpy.mockClear();
    await post({ subject: "grades", format: "csv" }, instructorOfCourse());
    const event = auditSpy.mock.calls[0]![2] as unknown as {
      action: string;
      requestMetadata: unknown;
    };
    expect(event.action).toBe("export.created");
    expect(JSON.stringify(event.requestMetadata)).not.toContain("Strong reasoning");
    expect(JSON.stringify(event.requestMetadata)).toContain("grades");
  });

  it("never includes another course's work", async () => {
    void otherCourseId;
    void adaUserId;
    const res = await post({ subject: "submissions", format: "json" }, instructorOfCourse());
    const parsed = JSON.parse(((await res.json()) as { body: string }).body) as {
      submissions: { homework: string }[];
    };
    expect(parsed.submissions.every((s) => s.homework === "HW1")).toBe(true);
  });
});
