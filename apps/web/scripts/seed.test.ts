import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import { organizations, courses, users, conversations, submissions, messages, grades, llmCallLogs, courseMemberships, homeworks, sections } from "../src/db/schema";
import { IdentityCipher } from "../src/lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../src/lib/secrets-loader";

const DATABASE_URL = process.env.DATABASE_URL;
const CAN_SEED = DATABASE_URL && process.env.ENCRYPTION_KEY && process.env.BLIND_INDEX_KEY;

describe.skipIf(!CAN_SEED)("db:seed script", () => {
  let db: Db;

  beforeAll(() => {
    execSync("npx tsx scripts/seed.ts --reset", { cwd: __dirname + "/..", stdio: "inherit" });
    db = makeNodeDb(DATABASE_URL!);
  });

  it("creates exactly one seed-org organization", async () => {
    const rows = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    expect(rows).toHaveLength(1);
  });

  it("creates 5 users with encrypted (non-empty bytea) email fields", async () => {
    const rows = await db.select().from(users).where(eq(users.isPending, true));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.email.length).toBeGreaterThan(0);
      expect(row.emailBlindIndex.length).toBeGreaterThan(0);
    }
  });

  it("creates 2 homeworks", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    const rows = await db.query.homeworks.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(org).toBeDefined();
  });

  it("running --reset twice in a row succeeds both times (idempotent)", () => {
    expect(() =>
      execSync("npx tsx scripts/seed.ts --reset", { cwd: __dirname + "/..", stdio: "pipe" }),
    ).not.toThrow();
  });

  it("decrypts a seeded user's email via the same key-loading path the app uses", async () => {
    const keys = await loadIdentityCipherKeys(process.env as unknown as Env);
    const cipher = new IdentityCipher(keys);
    // #245: selected by the blind index of a *known* seed email, not
    // `limit(1)` over every pending user. reset() deletes seeded users by
    // blind index computed with the current BLIND_INDEX_KEY, so users seeded
    // under a previous run's key survive; an arbitrary pending row could
    // therefore be one encrypted with a key that no longer exists, and the
    // decrypt below would fail for reasons that have nothing to do with the
    // key-loading path this test exists to cover. CI never sees it (fresh
    // container per run); locally it fails on the second run onward.
    const blindIndex = await cipher.computeBlindIndex(
      IdentityCipher.normalizeEmail("student1@test.com"),
    );
    const [row] = await db.select().from(users).where(eq(users.emailBlindIndex, blindIndex));
    expect(row).toBeDefined();
    const email = await cipher.decryptString(row.email);
    expect(email).toBe("student1@test.com");
  });

  it("running without --reset a second time fails with a friendly 'already seeded' message, not a raw pg dump", () => {
    expect(() =>
      execSync("npx tsx scripts/seed.ts", { cwd: __dirname + "/..", stdio: "pipe" }),
    ).toThrowError(/already seeded -- use --reset/);
  });

  // 20s, not the 5s default: unlike the execSync-only tests above (which
  // block the event loop synchronously and so never actually let vitest's
  // timeout timer fire), this test awaits DB calls around the execSync,
  // which genuinely exposes it to the ~10s tsx process-start cost.
  it("--reset succeeds after a grade and an llm_call_log exist under the seed org", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    const [sub] = await db.select().from(submissions).where(eq(submissions.organizationId, org.id)).limit(1);
    const [msg] = await db.select().from(messages).where(eq(messages.conversationId, sub.conversationId)).limit(1);

    // Simulates "a developer chatted against / graded the seeded data
    // locally" before running --reset. Not a RESTRICT-avoidance regression
    // test (#138: org deletion was never blocked by these -- see below for
    // the test that actually asserts that) -- this just confirms reset()
    // keeps working when the seed org has real data hanging off it.
    await db.insert(grades).values({ submissionId: sub.id, organizationId: org.id, gradedByAi: true });
    await db.insert(llmCallLogs).values({
      messageId: msg.id,
      conversationId: msg.conversationId,
      organizationId: org.id,
      provider: "anthropic",
      model: "claude-sonnet",
    });

    expect(() =>
      execSync("npx tsx scripts/seed.ts --reset", { cwd: __dirname + "/..", stdio: "pipe" }),
    ).not.toThrow();

    const [reseededOrg] = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    expect(reseededOrg.id).not.toBe(org.id);
  }, 20_000);

  // The actual #138 regression test: asserts the *documented* behavior
  // (org deletion cascades grades/llm_call_logs away) directly against the
  // database, independent of reset()'s own defense-in-depth pre-clearing --
  // the test above would pass even if that pre-clearing were reverted,
  // since the org delete itself never needed it to succeed.
  it("deleting an organization directly cascades away its grades and llm_call_logs, it is not blocked by them (#138)", async () => {
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `cascade-check-${crypto.randomUUID()}`,
        name: "Cascade Check Org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org.id, code: "CC", term: "T", title: "T" })
      .returning({ id: courses.id });
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    // #128: a submission's composite FK ties it to its conversation's owner
    // and section, and section_id is NOT NULL -- so this can no longer hang a
    // submission off a `tutor` conversation the way it used to. The cascade
    // being tested is unchanged; only the carrier had to become a real
    // section conversation.
    const [membership] = await db
      .insert(courseMemberships)
      .values({ userId: user.id, courseId: course.id, role: "instructor" })
      .returning({ id: courseMemberships.id });
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId: course.id,
        createdById: membership.id,
        title: "h",
        description: "d",
        dueDate: new Date(),
      })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "s", content: "c" })
      .returning({ id: sections.id });
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerUserId: user.id,
        courseId: course.id,
        sectionId: section.id,
        kind: "section",
        title: "cascade-check",
      })
      .returning({ id: conversations.id });
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv.id, role: "user", parts: [{ type: "text", text: "hi" }] })
      .returning({ id: messages.id });
    const [sub] = await db
      .insert(submissions)
      .values({ conversationId: conv.id, organizationId: org.id, userId: user.id, sectionId: section.id })
      .returning({ id: submissions.id });
    const [grade] = await db
      .insert(grades)
      .values({ submissionId: sub.id, organizationId: org.id, gradedByAi: true })
      .returning({ id: grades.id });
    const [log] = await db
      .insert(llmCallLogs)
      .values({
        messageId: msg.id,
        conversationId: conv.id,
        organizationId: org.id,
        provider: "anthropic",
        model: "claude-sonnet",
      })
      .returning({ id: llmCallLogs.id });

    await expect(db.delete(organizations).where(eq(organizations.id, org.id))).resolves.not.toThrow();

    const remainingGrades = await db.select().from(grades).where(eq(grades.id, grade.id));
    const remainingLogs = await db.select().from(llmCallLogs).where(eq(llmCallLogs.id, log.id));
    expect(remainingGrades).toHaveLength(0);
    expect(remainingLogs).toHaveLength(0);

    await db.delete(users).where(eq(users.id, user.id));
  });
});
