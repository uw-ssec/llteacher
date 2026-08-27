import { and, eq, or } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import { IdentityCipher } from "../src/lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../src/lib/secrets-loader";

// Thrown for expected, user-actionable misconfiguration (missing env var,
// unsafe --reset target, already seeded) -- distinguished from an
// unexpected bug so the top-level catch can print just the message instead
// of a full stack trace (found in PR #127 round-2 review, #140).
class SeedUsageError extends Error {}

// Routed through the same loadIdentityCipherKeys() the Worker uses (not a
// hand-rolled key import) so seeded PII is encrypted under the app's actual
// active key id -- decryptString hard-fails on any other id, which silently
// broke every seeded user's roster/profile view until this was routed
// through the shared loader.
async function loadCipher(): Promise<IdentityCipher> {
  if (!process.env.ENCRYPTION_KEY || !process.env.BLIND_INDEX_KEY) {
    throw new SeedUsageError("ENCRYPTION_KEY and BLIND_INDEX_KEY must be set to run the seed script");
  }
  const keys = await loadIdentityCipherKeys(process.env as unknown as Env);
  return new IdentityCipher(keys);
}

interface SeedUserSpec {
  handle: string;
  email: string;
  displayName: string;
  role: "instructor" | "student";
}

// example.com (not test.com): WorkOS's own documented safe-test-domain
// convention -- "WorkOS accepts these addresses but never sends email to
// them" (https://workos.com/docs/authkit/environments). A seeded account
// only becomes usable for real, interactive testing once someone actually
// signs up through WorkOS's own AuthKit as this exact email (see this
// file's own module doc comment and README.md's "Seeding a dev dataset"
// section on the claim-by-blind-index mechanism) -- test.com has no such
// carve-out, so AuthKit's normal email+password flow tries to send it a
// real verification email that can never be delivered, permanently
// blocking sign-up. example.com/.org/.net are the IANA-reserved domains
// WorkOS explicitly recognizes and skips delivery for instead.
const SEED_USERS: SeedUserSpec[] = [
  { handle: "teacher1", email: "teacher1@example.com", displayName: "John Doe", role: "instructor" },
  { handle: "teacher2", email: "teacher2@example.com", displayName: "Jane Smith", role: "instructor" },
  { handle: "student1", email: "student1@example.com", displayName: "Alice Johnson", role: "student" },
  { handle: "student2", email: "student2@example.com", displayName: "Bob Wilson", role: "student" },
  { handle: "student3", email: "student3@example.com", displayName: "Carol Brown", role: "student" },
];

// #317 review, #325: relocated verbatim from lib/prompts.ts's
// DEFAULT_SYSTEM_PROMPT, which used to hardcode this UW-statistics-specific
// pedagogy as the code-level fallback for every org, seeded or not. Now it
// only lives here, as this dev org's real org-scoped prompt_templates row
// -- DEFAULT_SYSTEM_PROMPT itself is subject-neutral, since LLTeacher is
// the shared base for other CDI-funded projects that are not statistics
// courses. A real template resolves with TUTOR_GUARDRAIL NOT appended
// (see that constant's doc comment), so this paragraph is this
// deployment's complete, final pedagogy statement -- not a fragment
// something else quietly completes.
const TUTOR_BASE_PROMPT = `You are an AI tutor for an introductory statistics course at the University of Washington. Your job is to guide students through homework problems using the Socratic method: ask leading questions, build intuition step by step, never just dump the answer.

You have one structured rendering tool available: showDefinition. Call it whenever you are formally introducing a named statistical concept ("p-value", "null hypothesis", "standard error", "confidence interval", "type I error", etc.), give the student a polished definition card with the term and a 1-2 sentence plain-language body. For everything else (guiding questions, follow-ups, gentle nudges, walking through computations), reply in plain markdown, no tool call.

Be warm, curious, and patient. Prefer questions over assertions.`;

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

// node-postgres's connection-string parser (pg-connection-string) copies
// every query param into its config object *before* falling back to the
// URL's own authority hostname -- a `host` (or `hostaddr`) query param
// silently overrides where the TCP connection actually goes.
// postgres://localhost/db?host=ep-prod.neon.tech passes a naive
// `new URL(...).hostname` check while actually connecting to
// ep-prod.neon.tech. Query params win here, matching pg's own precedence
// (found in PR #127 round-2 review, #140).
function resolveEffectiveHostname(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return url.searchParams.get("host") ?? url.searchParams.get("hostaddr") ?? url.hostname;
}

function assertLocalOrForced(databaseUrl: string, forced: boolean) {
  const hostname = resolveEffectiveHostname(databaseUrl);
  // *.local dropped from the allowlist: it's ambiguous whether it means
  // "my own machine" (mDNS/Bonjour, safe) or "some other host on a
  // corporate AD network" (not necessarily disposable) -- nothing in this
  // repo's documented dev/CI setup relies on it, so requiring --force for
  // it too is strictly safer, not a regression.
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocal && !forced) {
    throw new SeedUsageError(
      `Refusing to run --reset against non-local DATABASE_URL host "${hostname}" without --force. ` +
        `--reset wipes every row in the seed org's subtree; re-run with --force only if you are ` +
        `certain this database is disposable.`,
    );
  }
  if (forced) {
    console.log(`--force set: proceeding against DATABASE_URL host "${hostname}".`);
  }
}

async function reset(db: Db, cipher: IdentityCipher) {
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, "seed-org"));

  if (org) {
    // Not load-bearing (#138): grades.organization_id and
    // llm_call_logs.organization_id are each their own direct CASCADE to
    // organizations, so deleting the org below would clear these rows on
    // its own even without this pre-clear -- deleting an org silently
    // cascades away its grades and LLM call logs, it is never blocked by
    // them (see the #138 correction in
    // docs/architecture/multi-tenant-data-model.md §3.5 Q5). Kept anyway
    // as harmless defense-in-depth and a self-documenting delete order.
    await db.delete(schema.grades).where(eq(schema.grades.organizationId, org.id));
    await db.delete(schema.llmCallLogs).where(eq(schema.llmCallLogs.organizationId, org.id));
  }

  // Deleting the seed org cascades through courses -> homeworks -> sections
  // -> everything org-anchored (course_memberships, conversations, messages,
  // submissions, citations, student_profiles, llm_configs, prompt_templates,
  // audit_events) -- see the FK onDelete chains in
  // db/schema/{content,runtime}.ts. Scoping to the seed-org slug, rather
  // than deleting every row in each table, is what keeps this safe to run
  // alongside other orgs' data (including other test suites' fixtures).
  await db.delete(schema.organizations).where(eq(schema.organizations.slug, "seed-org"));
  // Scoped to the known seed users' own email blind indexes, not just
  // isPending=true globally (found in PR #127 round-2 review, #140):
  // isPending=true was only ever a proxy for "seeded", and once any real
  // invite/roster-provisioning flow creates pending users of its own (e.g.
  // #60's NRPS roster sync), `--reset --force` on a shared DB would wipe
  // those too. isPending=true stays as a second, redundant guard -- it
  // should never diverge from the blind-index scoping for genuinely seeded
  // rows, but costs nothing to keep. Users aren't in the org's cascade tree
  // by design (an org being deleted must never delete real user rows), so
  // they need this separate, still-scoped delete.
  const seedEmailBlindIndexes = await Promise.all(
    SEED_USERS.map((spec) => cipher.computeBlindIndex(IdentityCipher.normalizeEmail(spec.email))),
  );
  await db
    .delete(schema.users)
    .where(
      and(
        eq(schema.users.isPending, true),
        or(...seedEmailBlindIndexes.map((bi) => eq(schema.users.emailBlindIndex, bi))),
      ),
    );
}

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new SeedUsageError("DATABASE_URL not set");

  const shouldReset = process.argv.includes("--reset");
  const forced = process.argv.includes("--force");
  const cipher = await loadCipher();
  const db = makeNodeDb(databaseUrl);

  if (shouldReset) {
    assertLocalOrForced(databaseUrl, forced);
    console.log("Resetting seeded data...");
    await reset(db, cipher);
  }

  let org: typeof schema.organizations.$inferSelect;
  try {
    [org] = await db
      .insert(schema.organizations)
      .values({
        slug: "seed-org",
        name: "Seed University Statistics",
        workosOrganizationId: "seed-workos-org",
      })
      .returning();
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "23505") {
      throw new SeedUsageError("already seeded -- use --reset to wipe and re-seed");
    }
    throw e;
  }

  const [course] = await db
    .insert(schema.courses)
    .values({ organizationId: org.id, code: "STAT 311", term: "Fall 2026", title: "Intro to Statistics" })
    .returning();

  const userIds: Record<string, string> = {};
  const membershipIds: Record<string, string> = {};
  for (const spec of SEED_USERS) {
    const normalizedEmail = IdentityCipher.normalizeEmail(spec.email);
    const emailBlindIndex = await cipher.computeBlindIndex(normalizedEmail);
    // reset()'s user-delete is scoped to isPending=true by design ("an org
    // being deleted must never delete real user rows") -- so a seed user
    // that's already been CLAIMED via a real WorkOS login survives --reset
    // untouched, and inserting a fresh row for the same email blind index
    // would collide on users_email_blind_index_uq. onConflictDoNothing +
    // re-select reuses that claimed row's real id instead of erroring, so
    // --reset stays safe to run again after someone has actually logged in
    // as a seed account -- the whole point of these being real, testable
    // WorkOS identities rather than throwaway fixture rows.
    await db
      .insert(schema.users)
      .values({
        email: await cipher.encryptString(spec.email),
        emailBlindIndex,
        displayName: await cipher.encryptString(spec.displayName),
        isPending: true, // claimable on first real WorkOS login
      })
      .onConflictDoNothing({ target: schema.users.emailBlindIndex });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.emailBlindIndex, emailBlindIndex));
    userIds[spec.handle] = user.id;

    const [membership] = await db
      .insert(schema.courseMemberships)
      .values({ userId: user.id, courseId: course.id, role: spec.role })
      .returning();
    membershipIds[spec.handle] = membership.id;
  }

  // #333 follow-up: platform default is the LLMoxie gateway -- no
  // credentialId, so this resolves its key from the LLMOXIE_API_KEY env var
  // rather than an instructor-supplied credential. A seeded "anthropic"
  // config would resolve fine but fail at buildProviderClient with
  // UnsupportedLLMProviderError the moment anyone actually chats.
  const [llmConfig] = await db
    .insert(schema.llmConfigs)
    .values({
      organizationId: org.id,
      name: "Socratic Default",
      // #340/#178: provider+model must match migration 0035's backfill and
      // ensurePlatformDefaultLLMConfig's constants exactly -- a freshly
      // seeded org and a freshly migrated one are meant to land on identical
      // behaviour. Seeding 'anthropic' here would also reintroduce precisely
      // the legacy-provider row that 0029 exists to UPDATE away.
      provider: "llmoxie",
      modelName: "gpt-5.3-codex",
      basePrompt:
        "You are an AI tutor for an introductory statistics course. Guide students " +
        "through problems using the Socratic method: ask leading questions, build " +
        "intuition step by step, and never simply state the answer.",
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
        // #94: publishedAt/releasedAt both null (the schema's own default)
        // means "draft" -- deriveHomeworkStatus filters that out of the
        // student list entirely (repositories/homeworks.ts's
        // UNRELEASED_STATUSES). This seed exists to exercise the real
        // student round trip (the conversations/submissions created below
        // are for exactly that), so publishedAt is set explicitly here;
        // releasedAt stays null (released immediately on publish, same as
        // the admin console's own default when an instructor doesn't pick
        // a future release date).
        publishedAt: new Date(),
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

      // Deterministic, not Math.random() < 0.6 -- matches the Django
      // reference's `i % 5 < 3` shape (3-of-5 submitted) so seeded data is
      // reproducible run to run instead of drifting between 4-vs-5
      // submissions across runs.
      if ((conversationCount - 1) % 5 < 3) {
        // #128: user_id/section_id are NOT NULL and composite-FK-checked
        // against the conversation, so they must be the same owner and
        // section the conversation above was created with.
        await db.insert(schema.submissions).values({
          conversationId: conv.id,
          organizationId: org.id,
          userId: userIds[studentHandle],
          sectionId: section.id,
        });
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
  // SeedUsageError is expected/user-actionable -- the message alone is the
  // useful part; a full stack trace is noise. Anything else is an
  // unexpected bug, where the stack trace is exactly what's needed.
  if (e instanceof SeedUsageError) {
    console.error(e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
});
