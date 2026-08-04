import { eq } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import { IdentityCipher } from "../src/lib/crypto/identity-cipher";

async function loadCipher(): Promise<IdentityCipher> {
  const encKeyB64 = process.env.ENCRYPTION_KEY;
  const blindKeyB64 = process.env.BLIND_INDEX_KEY;
  if (!encKeyB64 || !blindKeyB64) {
    throw new Error("ENCRYPTION_KEY and BLIND_INDEX_KEY must be set to run the seed script");
  }
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(encKeyB64, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const blindIndexKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(blindKeyB64, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new IdentityCipher({ encryptionKey, blindIndexKey, encryptionKeyId: "seed" });
}

interface SeedUserSpec {
  handle: string;
  email: string;
  displayName: string;
  role: "instructor" | "student";
}

const SEED_USERS: SeedUserSpec[] = [
  { handle: "teacher1", email: "teacher1@test.com", displayName: "John Doe", role: "instructor" },
  { handle: "teacher2", email: "teacher2@test.com", displayName: "Jane Smith", role: "instructor" },
  { handle: "student1", email: "student1@test.com", displayName: "Alice Johnson", role: "student" },
  { handle: "student2", email: "student2@test.com", displayName: "Bob Wilson", role: "student" },
  { handle: "student3", email: "student3@test.com", displayName: "Carol Brown", role: "student" },
];

const TUTOR_BASE_PROMPT =
  "You are a patient, Socratic statistics tutor. Never give the final answer " +
  "outright -- ask guiding questions that help the student discover the " +
  "reasoning themselves. Keep responses concise and encouraging.";

// Three message shapes, cycled across seeded conversations to demonstrate
// the variety AI SDK's parts jsonb carries -- the spirit of Django's old
// student/ai/code/code_execution message_type split, expressed through
// part.type instead of a separate content_type column (see M2 design
// decision #2: content_type -> parts jsonb).
type SeedMessageSpec = { role: "user" | "assistant" | "system"; parts: unknown };

const MESSAGE_PATTERNS: Array<(sectionTitle: string) => SeedMessageSpec[]> = [
  (sectionTitle) => [
    { role: "user", parts: [{ type: "text", text: `I need help getting started on ${sectionTitle}.` }] },
    { role: "assistant", parts: [{ type: "text", text: "What have you tried so far?" }] },
  ],
  () => [
    {
      role: "user",
      parts: [
        {
          type: "text",
          text: "Here's what I have so far:\n\n```python\nx = [1, 2, 3]\nprint(x[0])\n```\n\nIs this right?",
        },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "Close! What does `x[0]` return for a list starting at index 0?" }] },
  ],
  () => [
    { role: "user", parts: [{ type: "text", text: "Can you run this for me?" }] },
    {
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "seed-call-1", toolName: "execute_python", args: { code: "sum([1, 2, 3])" } },
        { type: "tool-result", toolCallId: "seed-call-1", toolName: "execute_python", result: { stdout: "6\n", error: null } },
      ],
    },
  ],
];

async function reset(db: Db) {
  // Reverse dependency order.
  await db.delete(schema.citations);
  await db.delete(schema.grades);
  await db.delete(schema.submissions);
  await db.delete(schema.llmCallLogs);
  await db.delete(schema.messages);
  await db.delete(schema.conversations);
  await db.delete(schema.studentProfiles);
  await db.delete(schema.sectionSolutions);
  await db.delete(schema.sections);
  await db.delete(schema.homeworks);
  await db.delete(schema.llmConfigs);
  await db.delete(schema.courseMemberships);
  await db.delete(schema.courses);
  await db.delete(schema.organizations).where(eq(schema.organizations.slug, "seed-org"));
  // isPending=true, not false: seeded accounts are pending rows (nobody has
  // ever logged into them via WorkOS). Deleting isPending=false would wipe
  // real users who've actually signed in -- the opposite of what --reset
  // should ever touch.
  await db.delete(schema.users).where(eq(schema.users.isPending, true));
}

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  const shouldReset = process.argv.includes("--reset");
  const cipher = await loadCipher();
  const db = makeNodeDb(databaseUrl);

  if (shouldReset) {
    console.log("Resetting seeded data...");
    await reset(db);
  }

  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug: "seed-org",
      name: "Seed University Statistics",
      workosOrganizationId: "seed-workos-org",
    })
    .returning();

  const [course] = await db
    .insert(schema.courses)
    .values({ organizationId: org.id, code: "STAT 311", term: "Fall 2026", title: "Intro to Statistics" })
    .returning();

  const userIds: Record<string, string> = {};
  const membershipIds: Record<string, string> = {};
  for (const spec of SEED_USERS) {
    const normalizedEmail = IdentityCipher.normalizeEmail(spec.email);
    const [user] = await db
      .insert(schema.users)
      .values({
        email: await cipher.encryptString(spec.email),
        emailBlindIndex: await cipher.computeBlindIndex(normalizedEmail),
        displayName: await cipher.encryptString(spec.displayName),
        isPending: true, // claimable on first real WorkOS login
      })
      .returning();
    userIds[spec.handle] = user.id;

    const [membership] = await db
      .insert(schema.courseMemberships)
      .values({ userId: user.id, courseId: course.id, role: spec.role })
      .returning();
    membershipIds[spec.handle] = membership.id;
  }

  const [llmConfig] = await db
    .insert(schema.llmConfigs)
    .values({
      organizationId: org.id,
      provider: "anthropic",
      modelName: "claude-sonnet-4-5",
      temperature: 0.7,
      maxCompletionTokens: 1000,
      isDefault: true,
      isActive: true,
    })
    .returning();

  await db.insert(schema.promptTemplates).values({
    scopeOrganizationId: org.id,
    content: TUTOR_BASE_PROMPT,
    version: 1,
    isActive: true,
  });

  const homeworkSpecs = [
    {
      title: "Python Basics",
      createdBy: "teacher1",
      sections: [
        { title: "Variables and Data Types", content: "# Variables\n\nExplore Python types." },
        { title: "Control Structures", content: "# Control Structures\n\nIf/else and loops." },
        { title: "Functions and Lists", content: "# Functions\n\nDefine and call functions." },
      ],
    },
    {
      title: "Data Analysis with Python",
      createdBy: "teacher2",
      sections: [
        { title: "Working with Dictionaries", content: "# Dictionaries\n\nGrade management." },
        { title: "List Comprehensions", content: "# List Comprehensions\n\nFilter product data." },
        { title: "Summarizing Data with Pandas", content: "# Pandas\n\nGroup and summarize a dataset." },
      ],
    },
  ];

  const sectionsByHomework: Array<Array<{ id: string; title: string }>> = [];
  for (const hwSpec of homeworkSpecs) {
    const [hw] = await db
      .insert(schema.homeworks)
      .values({
        courseId: course.id,
        createdById: membershipIds[hwSpec.createdBy],
        llmConfigId: llmConfig.id,
        title: hwSpec.title,
        description: `${hwSpec.title} homework.`,
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();

    const sections: Array<{ id: string; title: string }> = [];
    for (let i = 0; i < hwSpec.sections.length; i++) {
      const [section] = await db
        .insert(schema.sections)
        .values({ homeworkId: hw.id, order: i + 1, title: hwSpec.sections[i].title, content: hwSpec.sections[i].content })
        .returning();
      await db.insert(schema.sectionSolutions).values({
        sectionId: section.id,
        content: `Model solution for ${hwSpec.sections[i].title}.`,
      });
      sections.push({ id: section.id, title: hwSpec.sections[i].title });
    }
    sectionsByHomework.push(sections);
  }

  const studentHandles = ["student1", "student2", "student3"];
  let conversationCount = 0;
  let submissionCount = 0;
  let patternIndex = 0;
  for (const studentHandle of studentHandles) {
    for (const sections of sectionsByHomework) {
      const section = sections[0];
      const [conv] = await db
        .insert(schema.conversations)
        .values({
          ownerUserId: userIds[studentHandle],
          courseId: course.id,
          sectionId: section.id,
          kind: "section",
          title: `${studentHandle}'s conversation`,
        })
        .returning();
      conversationCount++;

      const pattern = MESSAGE_PATTERNS[patternIndex % MESSAGE_PATTERNS.length];
      patternIndex++;
      await db.insert(schema.messages).values(
        pattern(section.title).map((m) => ({ conversationId: conv.id, role: m.role, parts: m.parts })),
      );

      if (Math.random() < 0.6) {
        await db.insert(schema.submissions).values({ conversationId: conv.id, organizationId: org.id });
        submissionCount++;
      }
    }
  }

  console.log(
    `Seed complete: 1 org, 1 course, 2 instructors, 3 students, 1 llm config, ` +
      `${homeworkSpecs.length} homeworks, ${conversationCount} conversations, ${submissionCount} submissions.`,
  );
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
