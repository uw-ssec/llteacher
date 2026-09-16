import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, llmConfigs, users, courseMemberships, citations, conversations, messages } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { createConversation } from "./conversations";
import { finalizeAssistantTurn } from "./conversations";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("concept citations (real DB)", () => {
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
      .values({ slug: `citations-${crypto.randomUUID()}`, name: "t", workosOrganizationId: `w-${crypto.randomUUID()}` })
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
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("finalizeAssistantTurn writes one citation per opened concept with the message", async () => {
    const messageId = crypto.randomUUID();
    await finalizeAssistantTurn(
      db,
      conversationId,
      { id: messageId, parts: [{ type: "text", text: "grounded" }] },
      {
        organizationId: orgId,
        llmConfigId,
        provider: "llmoxie",
        model: "m",
        providerRequestId: null,
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
        latencyMs: 5,
        errorFlag: false,
      },
      [{ conceptPath: "lectures/intro", conceptTitle: "Intro", courseId, organizationId: orgId }],
    );
    const rows = await db.select().from(citations).where(eq(citations.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conceptPath).toBe("lectures/intro");
    expect(rows[0]!.materialChunkId).toBeNull();
    await db.delete(messages).where(eq(messages.id, messageId));
  });

  it("rejects a citation with neither a chunk nor a concept", async () => {
    await expect(
      db.insert(citations).values({ messageId: null, gradeId: null, organizationId: orgId } as never),
    ).rejects.toThrow();
  });
});
