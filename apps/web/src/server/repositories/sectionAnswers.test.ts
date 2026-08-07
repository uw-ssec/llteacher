import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, homeworks, sections, courseMemberships } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import { upsertSectionAnswer, getSectionAnswer } from "./sectionAnswers";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("sectionAnswers repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let userAId: string;
  let membershipAId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `sa-repo-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `sa-repo-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB.id;
    const [courseA] = await db
      .insert(courses)
      .values({ organizationId: orgAId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseAId = courseA.id;
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [userA] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userAId = userA.id;
    const [membershipA] = await db
      .insert(courseMemberships)
      .values({ userId: userAId, courseId: courseAId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipAId = membershipA.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  async function newSection(type: "conversation" | "non_interactive" = "non_interactive") {
    const [hw] = await db
      .insert(homeworks)
      .values({ courseId: courseAId, createdById: membershipAId, title: "h", description: "d", dueDate: new Date() })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "s", content: "c", type })
      .returning({ id: sections.id });
    return section.id;
  }

  it("first submit creates a row", async () => {
    const sectionId = await newSection();
    const answer = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId, "my answer");
    expect(answer.content).toBe("my answer");
    expect(answer.sectionId).toBe(sectionId);
    expect(answer.userId).toBe(userAId);
  });

  it("second submit for the same (user, section) updates the same row, not a new one", async () => {
    const sectionId = await newSection();
    const first = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId, "first");
    const second = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId, "revised");
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("revised");

    const fetched = await getSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId);
    expect(fetched!.content).toBe("revised");
  });

  it("throws when submitting against a conversation-type section", async () => {
    const sectionId = await newSection("conversation");
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId, "answer"),
    ).rejects.toThrow(/does not accept a direct answer/i);
  });

  it("throws when the section belongs to a different org's course", async () => {
    const sectionId = await newSection();
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgBId), sectionId, userAId, "answer"),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  it("getSectionAnswer returns null when none exists", async () => {
    const sectionId = await newSection();
    const result = await getSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, userAId);
    expect(result).toBeNull();
  });
});
