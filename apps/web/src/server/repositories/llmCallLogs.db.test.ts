/* --------------------------------------------------------------------------
   #317 review, #321: llm_call_logs has existed since an earlier schema
   pass with nothing ever writing to it. This proves recordLlmCallLog
   actually persists a real row against real Postgres -- the chat.ts unit
   tests (chat.test.ts) already prove the call site passes the right
   fields; this proves the write itself round-trips.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, llmConfigs, users, courseMemberships, llmCallLogs } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { createConversation } from "./conversations";
import { recordLlmCallLog } from "./llmCallLogs";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("recordLlmCallLog (real DB, #321)", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let userId: string;
  let llmConfigId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `llmcalllogs-${crypto.randomUUID()}`, name: "t", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseId = course.id;
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;
    await db.insert(courseMemberships).values({ userId, courseId, role: "student" });
    const [cfg] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgId, name: "Test Config", provider: "openrouter", modelName: "test/model", isDefault: true })
      .returning({ id: llmConfigs.id });
    llmConfigId = cfg.id;
    const conv = await createConversation(db, unsafeCourseScope(courseId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "t",
    });
    conversationId = conv.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("persists a successful call's full token/cost/latency data", async () => {
    await recordLlmCallLog(db, {
      messageId: null,
      conversationId,
      organizationId: orgId,
      llmConfigId,
      provider: "openrouter",
      model: "test/model",
      providerRequestId: "req-123",
      inputTokens: 42,
      outputTokens: 17,
      costCents: 3,
      latencyMs: 812,
      errorFlag: false,
    });

    const rows = await db.select().from(llmCallLogs).where(eq(llmCallLogs.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerRequestId: "req-123",
      inputTokens: 42,
      outputTokens: 17,
      costCents: 3,
      latencyMs: 812,
      errorFlag: false,
    });
  });

  it("persists an error-flagged row with null messageId/tokens/cost", async () => {
    await recordLlmCallLog(db, {
      messageId: null,
      conversationId,
      organizationId: orgId,
      llmConfigId,
      provider: "openrouter",
      model: "test/model",
      providerRequestId: null,
      inputTokens: null,
      outputTokens: null,
      costCents: null,
      latencyMs: 60_000,
      errorFlag: true,
    });

    const rows = await db
      .select()
      .from(llmCallLogs)
      .where(eq(llmCallLogs.conversationId, conversationId));
    const errorRow = rows.find((r) => r.errorFlag);
    expect(errorRow).toBeDefined();
    expect(errorRow).toMatchObject({
      messageId: null,
      providerRequestId: null,
      inputTokens: null,
      outputTokens: null,
      costCents: null,
    });
  });
});
