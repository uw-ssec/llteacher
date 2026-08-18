/* --------------------------------------------------------------------------
   Instructor export of submissions, grades and transcripts (#91).

   SCOPE DECISION, recorded here because #91 asks for it to be:

   Exports are generated SYNCHRONOUSLY and returned in the response body,
   rather than queued with a signed download link. The issue's shape assumed
   #81's queue and #51's object storage; neither exists in this tree, and
   building a queue plus a bucket plus a retention rule to serve a file that
   is measured in hundreds of kilobytes would be infrastructure in search of
   a problem. A course's submissions and grades are bounded by its
   enrolment; transcripts are the large one and are bounded here explicitly.

   What that costs, stated so the next person does not have to rediscover it:
   a very large course's transcript export can approach the Worker's wall
   clock. The bound below is what keeps it honest -- an export that would
   exceed it is REFUSED with a sentence naming the narrower scope that will
   work, rather than truncated into a file that silently omits students.
   When #81 lands, this becomes the synchronous fast path and anything over
   the bound queues.

   FERPA: the artifact leaves the platform's control the moment it is
   downloaded. Every export writes an audit event recording its scope, and
   the data-flow doc should say plainly that exported files are outside the
   platform's retention and deletion guarantees (#53).
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { UUID_RE } from "../utils/uuid";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import {
  conversations,
  courseMemberships,
  grades,
  homeworks,
  messages,
  sections,
  submissions,
  users,
} from "../../db/schema";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import { messageTextOf } from "../utils/messageText";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CourseScope } from "../repositories/scope";
import type { ExportFormat, ExportSubject } from "@llteacher/ui/api";

/** The synchronous ceiling. Rows for submissions/grades, messages for
 *  transcripts. Chosen to sit well inside a Worker's budget with decryption
 *  on every row, and to be far above a real course. */
const MAX_ROWS = 5_000;

const SUBJECTS: ExportSubject[] = ["submissions", "grades", "transcripts"];
const FORMATS: ExportFormat[] = ["csv", "json"];

async function instructorContext(
  c: Context<AppEnv>,
): Promise<{ scope: CourseScope; courseId: string; authContext: AuthContext } | null> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return null;
  const scope = courseScopeFromAuthContext(authContext, courseId);
  return scope ? { scope, courseId, authContext } : null;
}

/** RFC 4180 quoting. Every field is quoted unconditionally rather than only
 *  when it contains a delimiter: the conditional version is where CSV
 *  writers get subtly wrong, and the cost is a slightly larger file.
 *
 *  The leading apostrophe on formula-leading values is deliberate. A cell
 *  beginning =, +, - or @ is executed as a formula by Excel and Sheets on
 *  open, which turns an exported student name into a CSV-injection vector
 *  aimed at the instructor's own machine. Prefixing neutralises it and is
 *  visible, which is better than a file that runs something. */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  // \r\n and a UTF-8 BOM: Excel opens a bare-LF UTF-8 file as mojibake for
  // any non-ASCII name, which for a university roster is most of the
  // interesting cases.
  const body = [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  return `﻿${body}\r\n`;
}

export async function createExportHandler(c: Context<AppEnv>) {
  const ctx = await instructorContext(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  let body: { subject?: unknown; format?: unknown; studentId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const subject = body.subject as ExportSubject;
  if (!SUBJECTS.includes(subject)) {
    return c.json({ error: `Choose what to export: ${SUBJECTS.join(", ")}.` }, 400);
  }
  const format = body.format as ExportFormat;
  if (!FORMATS.includes(format)) {
    return c.json({ error: `Choose a format: ${FORMATS.join(", ")}.` }, 400);
  }
  const studentId = typeof body.studentId === "string" && body.studentId ? body.studentId : null;
  if (studentId && !UUID_RE.test(studentId)) {
    return c.json({ error: "That student reference is not valid." }, 400);
  }
  // Transcripts as CSV would be one row per message with the text in a cell
  // -- technically expressible and useless to read. #91 records the scope
  // decision: transcripts are structured JSON.
  if (subject === "transcripts" && format === "csv") {
    return c.json(
      { error: "Transcripts export as JSON. A conversation is not a table." },
      400,
    );
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));

  // The student filter is applied as a course-scoped MEMBERSHIP lookup, not
  // as a bare user id in the data query: a user id from the request must not
  // select rows on its own, or a per-student export becomes a way to name
  // any user in the system and see whether they have work here.
  if (studentId) {
    const [member] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(
        and(eq(courseMemberships.userId, studentId), eq(courseMemberships.courseId, ctx.scope)),
      );
    if (!member) return c.json({ error: "That student is not on this course." }, 404);
  }

  try {
    const artifact =
      subject === "transcripts"
        ? await exportTranscripts(db, ctx.scope, cipher, studentId, ctx.authContext.session.userId)
        : subject === "grades"
          ? await exportGrades(db, ctx.scope, cipher, studentId, format)
          : await exportSubmissions(db, ctx.scope, cipher, studentId, format);

    if (artifact === null) {
      return c.json(
        {
          error: `That export is larger than this console can build in one request (over ${MAX_ROWS} rows). Export one student at a time, or contact an administrator.`,
        },
        413,
      );
    }

    try {
      const orgScope = await getOrgScopeForCourse(db, ctx.courseId);
      await auditBestEffort(db, orgScope ? [orgScope] : [], {
        actorUserId: ctx.authContext.session.userId,
        action: AUDIT_ACTIONS.DATA_EXPORTED,
        targetType: studentId ? AUDIT_TARGET_TYPES.USER : AUDIT_TARGET_TYPES.COURSE,
        targetId: studentId ?? ctx.courseId,
        // The SCOPE of what left, never the contents.
        requestMetadata: { courseId: ctx.courseId, subject, format, scope: studentId ? "student" : "course" },
      });
    } catch (err) {
      logServerError("createExportHandler", err);
    }

    return c.json(artifact);
  } catch (err) {
    logServerError("createExportHandler", err);
    return c.json({ error: "Could not build that export. Please try again." }, 503);
  }
}

interface Artifact {
  filename: string;
  contentType: string;
  body: string;
}

/** Submissions: one row per submitted section, with the student's identity
 *  decrypted at generation time. */
async function exportSubmissions(
  db: ReturnType<typeof makeDb>,
  scope: CourseScope,
  cipher: IdentityCipher,
  studentId: string | null,
  format: ExportFormat,
): Promise<Artifact | null> {
  const rows = await db
    .select({
      submissionId: submissions.id,
      submittedAt: submissions.submittedAt,
      homeworkTitle: homeworks.title,
      sectionTitle: sections.title,
      sectionOrder: sections.order,
      studentUserId: conversations.ownerUserId,
      displayName: users.displayName,
      email: users.email,
    })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .innerJoin(users, eq(conversations.ownerUserId, users.id))
    .where(
      studentId
        ? and(eq(conversations.courseId, scope), eq(conversations.ownerUserId, studentId))
        : eq(conversations.courseId, scope),
    )
    .orderBy(asc(homeworks.title), asc(sections.order), asc(submissions.submittedAt))
    .limit(MAX_ROWS + 1);
  if (rows.length > MAX_ROWS) return null;

  const decrypted = [];
  for (const r of rows) {
    decrypted.push({
      submissionId: r.submissionId,
      student: r.displayName ? await cipher.decryptString(r.displayName) : "",
      email: await cipher.decryptString(r.email),
      homework: r.homeworkTitle,
      section: r.sectionTitle,
      sectionNumber: r.sectionOrder,
      submittedAt: r.submittedAt?.toISOString() ?? "",
    });
  }

  if (format === "json") {
    return {
      filename: "submissions.json",
      contentType: "application/json",
      body: JSON.stringify({ submissions: decrypted }, null, 2),
    };
  }
  return {
    filename: "submissions.csv",
    contentType: "text/csv",
    body: toCsv(
      ["Submission ID", "Student", "Email", "Homework", "Section", "Section #", "Submitted at"],
      decrypted.map((d) => [
        d.submissionId,
        d.student,
        d.email,
        d.homework,
        d.section,
        d.sectionNumber,
        d.submittedAt,
      ]),
    ),
  };
}

/** Grades: every recorded grade, including superseded ones and AI drafts,
 *  with the type marked. End-of-quarter records need the current grade;
 *  a dispute needs the history, and separating them into two exports would
 *  mean the dispute case is the one nobody built. */
async function exportGrades(
  db: ReturnType<typeof makeDb>,
  scope: CourseScope,
  cipher: IdentityCipher,
  studentId: string | null,
  format: ExportFormat,
): Promise<Artifact | null> {
  const rows = await db
    .select({
      gradeId: grades.id,
      submissionId: grades.submissionId,
      score: grades.score,
      maxScore: grades.maxScore,
      feedback: grades.feedback,
      gradedByAi: grades.gradedByAi,
      gradedAt: grades.gradedAt,
      homeworkTitle: homeworks.title,
      sectionTitle: sections.title,
      studentDisplayName: users.displayName,
      studentEmail: users.email,
    })
    .from(grades)
    .innerJoin(submissions, eq(grades.submissionId, submissions.id))
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .innerJoin(users, eq(conversations.ownerUserId, users.id))
    .where(
      studentId
        ? and(eq(conversations.courseId, scope), eq(conversations.ownerUserId, studentId))
        : eq(conversations.courseId, scope),
    )
    .orderBy(asc(homeworks.title), asc(sections.order), desc(grades.gradedAt))
    .limit(MAX_ROWS + 1);
  if (rows.length > MAX_ROWS) return null;

  const decrypted = [];
  for (const r of rows) {
    decrypted.push({
      gradeId: r.gradeId,
      submissionId: r.submissionId,
      student: r.studentDisplayName ? await cipher.decryptString(r.studentDisplayName) : "",
      email: await cipher.decryptString(r.studentEmail),
      homework: r.homeworkTitle,
      section: r.sectionTitle,
      score: r.score,
      maxScore: r.maxScore,
      graderType: r.gradedByAi ? "ai_draft" : "human",
      feedback: r.feedback ?? "",
      gradedAt: r.gradedAt.toISOString(),
    });
  }

  if (format === "json") {
    return {
      filename: "grades.json",
      contentType: "application/json",
      body: JSON.stringify({ grades: decrypted }, null, 2),
    };
  }
  return {
    filename: "grades.csv",
    contentType: "text/csv",
    body: toCsv(
      ["Grade ID", "Submission ID", "Student", "Email", "Homework", "Section", "Score", "Out of", "Grader", "Feedback", "Graded at"],
      decrypted.map((d) => [
        d.gradeId,
        d.submissionId,
        d.student,
        d.email,
        d.homework,
        d.section,
        d.score,
        d.maxScore,
        d.graderType,
        d.feedback,
        d.gradedAt,
      ]),
    ),
  };
}

/** Transcripts: structured JSON, one object per conversation with its
 *  messages in order. Deliberately NOT tabular -- see the CSV refusal above. */
async function exportTranscripts(
  db: ReturnType<typeof makeDb>,
  scope: CourseScope,
  cipher: IdentityCipher,
  studentId: string | null,
  /** #354: the caller, so their OWN teacher-test conversations survive the
   *  filter while other instructors' do not. */
  requestingUserId: string,
): Promise<Artifact | null> {
  // #354: the export is scoped to what an instructor can actually SEE in
  // the console, which is narrower than "every conversation in the course".
  // Two exclusions, both of which the original left-join let through:
  //
  //  · `kind = 'section'` only. A tutor conversation is a student's general
  //    chat; nothing in the instructor console surfaces one, and #91 is
  //    explicit that the export may not exceed the view. An inner join on
  //    `sections` enforces the same thing structurally -- a conversation
  //    with no section cannot appear at all.
  //  · Teacher-test conversations belonging to SOMEONE ELSE. #27
  //    established that an instructor must not read another instructor's
  //    test run (canReadSectionConversation); an export that included them
  //    would be a way around that rule, not an exception to it. The
  //    caller's own tests are kept -- they are theirs.
  const convRows = await db
    .select({
      conversationId: conversations.id,
      startedAt: conversations.createdAt,
      studentUserId: conversations.ownerUserId,
      displayName: users.displayName,
      email: users.email,
      sectionTitle: sections.title,
      homeworkTitle: homeworks.title,
    })
    .from(conversations)
    .innerJoin(users, eq(conversations.ownerUserId, users.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(
      and(
        eq(conversations.courseId, scope),
        eq(conversations.kind, "section"),
        or(
          eq(conversations.isTeacherTest, false),
          eq(conversations.ownerUserId, requestingUserId),
        ),
        ...(studentId ? [eq(conversations.ownerUserId, studentId)] : []),
      ),
    )
    .orderBy(asc(conversations.createdAt));

  if (convRows.length === 0) {
    return { filename: "transcripts.json", contentType: "application/json", body: JSON.stringify({ conversations: [] }, null, 2) };
  }

  const ids = convRows.map((c) => c.conversationId);
  const messageRows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, parts: messages.parts, seq: messages.seq })
    .from(messages)
    .where(inArray(messages.conversationId, ids))
    .orderBy(asc(messages.conversationId), asc(messages.seq))
    .limit(MAX_ROWS + 1);
  if (messageRows.length > MAX_ROWS) return null;

  const byConversation = new Map<string, { role: string; text: string }[]>();
  for (const m of messageRows) {
    const list = byConversation.get(m.conversationId) ?? [];
    list.push({ role: m.role, text: messageTextOf(m.parts) });
    byConversation.set(m.conversationId, list);
  }

  const out = [];
  for (const c of convRows) {
    out.push({
      conversationId: c.conversationId,
      student: c.displayName ? await cipher.decryptString(c.displayName) : "",
      email: await cipher.decryptString(c.email),
      homework: c.homeworkTitle,
      section: c.sectionTitle,
      startedAt: c.startedAt.toISOString(),
      messages: byConversation.get(c.conversationId) ?? [],
    });
  }

  return {
    filename: "transcripts.json",
    contentType: "application/json",
    body: JSON.stringify({ conversations: out }, null, 2),
  };
}


