import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import { organizations, users, submissions, messages, grades, llmCallLogs } from "../src/db/schema";
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
    const [row] = await db.select().from(users).where(eq(users.isPending, true)).limit(1);
    const email = await cipher.decryptString(row.email);
    expect(email).toMatch(/@test\.com$/);
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
  it("--reset succeeds after a grade and an llm_call_log exist under the seed org (#138)", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    const [sub] = await db.select().from(submissions).where(eq(submissions.organizationId, org.id)).limit(1);
    const [msg] = await db.select().from(messages).where(eq(messages.conversationId, sub.conversationId)).limit(1);

    // Simulates "a developer chatted against / graded the seeded data
    // locally" -- the exact scenario #138 found reset() breaking under,
    // since grades.submission_id and llm_call_logs' FKs are RESTRICT.
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
});
