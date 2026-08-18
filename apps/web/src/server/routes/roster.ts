/* --------------------------------------------------------------------------
   The course roster (#32) and its bulk CSV import (#86).

   Both write through `upsertCourseMember` -- the one provisioning pipeline
   in repositories/roster.ts, shared with #210's NetID entry and with the
   Canvas sync to come (#74/#11x). #86 is explicit that a second
   implementation is the thing to fix first, so there is not one.

   Instructor-of-course only. A TA is a grader: they read student work, they
   do not decide who is in the class.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { UUID_RE } from "../utils/uuid";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { parseRosterCsv } from "../../lib/csv";
import {
  allowedDomainsForCourse,
  listCourseRoster,
  removeCourseMember,
  upsertCourseMember,
  type CourseRole,
  type ProvisionResult,
} from "../repositories/roster";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CourseScope } from "../repositories/scope";
import type {
  RosterImportRowPayload,
  RosterListPayload,
  RosterRowStatus,
} from "@llteacher/ui/api";

/** Roles an instructor may enrol someone as from the console.
 *
 *  `instructor` and `admin` are deliberately absent. Granting co-instructor
 *  authority is a different decision with a different blast radius -- it
 *  hands someone the ability to publish content, grant answer-key access and
 *  remove other people -- and it should not be reachable by typing a word
 *  into a CSV column. When that is wanted it gets its own surface and its
 *  own confirmation. */
const ENROLLABLE_ROLES = ["student", "ta", "observer"] as const;
type EnrollableRole = (typeof ENROLLABLE_ROLES)[number];

function parseRole(raw: string | undefined): EnrollableRole | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "student";
  // Spreadsheet vocabulary, not database vocabulary: instructors write
  // "TA", "Teaching Assistant", "Student", "Auditor".
  if (["student", "students", "enrolled"].includes(value)) return "student";
  if (["ta", "teaching assistant", "teachingassistant", "grader"].includes(value)) return "ta";
  if (["observer", "auditor", "audit"].includes(value)) return "observer";
  return null;
}

async function instructorScope(
  c: Context<AppEnv>,
): Promise<{ scope: CourseScope; courseId: string; authContext: AuthContext } | null> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return null;
  const scope = courseScopeFromAuthContext(authContext, courseId);
  return scope ? { scope, courseId, authContext } : null;
}

export async function listRosterHandler(c: Context<AppEnv>) {
  const ctx = await instructorScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  const search = c.req.query("search") ?? undefined;
  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const { members, total } = await listCourseRoster(db, ctx.scope, cipher, { search });
  const body: RosterListPayload = { members, total };
  return c.json(body);
}

/** #32: manual add -- one address, one membership. The single-entry door to
 *  the same pipeline the CSV importer uses in bulk. */
export async function addRosterMemberHandler(c: Context<AppEnv>) {
  const ctx = await instructorScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  let body: { email?: unknown; displayName?: unknown; role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return c.json({ error: "Enter an email address." }, 400);
  const role = parseRole(typeof body.role === "string" ? body.role : undefined);
  if (!role) {
    return c.json(
      { error: `Role must be one of: ${ENROLLABLE_ROLES.join(", ")}.` },
      400,
    );
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const allowedDomains = await allowedDomainsForCourse(db, ctx.scope);
  const result = await upsertCourseMember(
    db,
    ctx.scope,
    cipher,
    {
      email,
      displayName: typeof body.displayName === "string" ? body.displayName.trim() : undefined,
      role: role as CourseRole,
    },
    allowedDomains,
  );

  if (result.status === "invalid_email" || result.status === "disallowed_domain") {
    return c.json({ error: result.message ?? "That email address cannot be enrolled." }, 400);
  }
  if (result.status === "role_conflict") {
    return c.json(
      {
        error: `That person is already on this course as ${result.existingRole}. Remove them first if you need to change their role.`,
      },
      409,
    );
  }

  await auditRoster(c, ctx, result, { role });
  return c.json(result, result.status === "already_enrolled" ? 200 : 201);
}

const MAX_IMPORT_BYTES = 1024 * 1024;

/** #86: CSV import, preview-first.
 *
 *  ONE endpoint with a `preview` flag rather than a separate validate route,
 *  and that is the point: the rows an instructor confirms are produced by
 *  exactly the code that will write them. A separate validation path is free
 *  to disagree with the real one, and the disagreement only shows up as a
 *  commit that does something the preview did not promise.
 *
 *  Preview does everything the commit does except the write -- same parse,
 *  same domain check, same duplicate detection, same role parsing. The one
 *  thing it cannot know is whether an address is already enrolled, since
 *  that requires a read it does perform; so preview statuses are accurate
 *  unless the roster changes between the two calls, which is a race an
 *  instructor can see in the result.
 *
 *  Partial failure is isolated per row: valid rows land even when others do
 *  not. An all-or-nothing import of an 80-row file with four typos is a file
 *  the instructor cannot use. */
export async function importRosterHandler(c: Context<AppEnv>) {
  const ctx = await instructorScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  let body: { csv?: unknown; preview?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) return c.json({ error: "Choose a CSV file to import." }, 400);
  if (csv.length > MAX_IMPORT_BYTES) {
    return c.json({ error: "That file is too large. Roster files are text, not spreadsheets." }, 400);
  }
  // Defaults to a preview. Getting this wrong in the safe direction means an
  // instructor sees rows they must confirm; getting it wrong the other way
  // means a file is written when they only meant to look at it.
  const preview = body.preview !== false;

  const parsed = parseRosterCsv(csv);
  if (parsed.error) return c.json({ error: parsed.error }, 400);
  if (parsed.rows.length === 0) {
    return c.json({ error: "That file has a header but no rows." }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const allowedDomains = await allowedDomainsForCourse(db, ctx.scope);

  const rows: RosterImportRowPayload[] = [];
  // Within-file duplicates are reported rather than silently collapsed: a
  // roster with the same address twice usually means two different people
  // were pasted onto one line, and the instructor needs to look.
  const seen = new Set<string>();

  for (const row of parsed.rows) {
    const rawEmail = row.values.email ?? "";
    const name = row.values.name ?? "";
    const roleText = row.values.role ?? "";
    const base = { line: row.line, email: rawEmail, name, role: roleText };

    const key = IdentityCipher.normalizeEmail(rawEmail);
    if (key && seen.has(key)) {
      rows.push({ ...base, status: "duplicate_row", message: "This address appears earlier in the file." });
      continue;
    }
    if (key) seen.add(key);

    const role = parseRole(roleText);
    if (!role) {
      rows.push({
        ...base,
        status: "role_conflict",
        message: `"${roleText}" is not a role. Use one of: ${ENROLLABLE_ROLES.join(", ")}.`,
      });
      continue;
    }

    if (preview) {
      // The read half of upsertCourseMember, without the write: the domain
      // check is the same call the commit makes, so a row that previews as
      // valid cannot fail validation on commit.
      const check = await previewRow(db, ctx.scope, cipher, key, role, allowedDomains);
      rows.push({ ...base, status: check.status, message: check.message });
      continue;
    }

    const result = await upsertCourseMember(
      db,
      ctx.scope,
      cipher,
      { email: rawEmail, displayName: name || undefined, role: role as CourseRole },
      allowedDomains,
    );
    rows.push({
      ...base,
      status: toRowStatus(result.status),
      membershipId: result.membershipId,
      message:
        result.status === "role_conflict"
          ? `Already on this course as ${result.existingRole}. Not changed.`
          : result.message,
    });
  }

  const added = rows.filter((r) => r.status === "added").length;
  const restored = rows.filter((r) => r.status === "restored").length;
  const failed = rows.filter(
    (r) => r.status !== "added" && r.status !== "restored" && r.status !== "already_enrolled",
  ).length;

  if (!preview && added + restored > 0) {
    // One event for the import, not one per row: the act being audited is
    // "an instructor imported a roster", and a 200-row file would otherwise
    // bury every other event in the org's log for that day.
    try {
      const orgScope = await getOrgScopeForCourse(db, ctx.courseId);
      await auditBestEffort(db, orgScope ? [orgScope] : [], {
        actorUserId: ctx.authContext.session.userId,
        action: AUDIT_ACTIONS.ROSTER_IMPORTED,
        targetType: AUDIT_TARGET_TYPES.COURSE,
        targetId: ctx.courseId,
        requestMetadata: { added, restored, failed, rows: rows.length },
      });
    } catch (err) {
      logServerError("importRosterHandler", err);
    }
  }

  return c.json({ rows, preview, added, restored, failed });
}

/** The preview's verdict for one row: everything the commit checks, minus
 *  the write. Kept beside the importer rather than in the repository because
 *  it exists only to answer "what would happen", which is a route-layer
 *  question -- the repository's job is to make it happen. */
async function previewRow(
  db: ReturnType<typeof makeDb>,
  scope: CourseScope,
  cipher: IdentityCipher,
  normalizedEmail: string,
  role: EnrollableRole,
  allowedDomains: string[],
): Promise<{ status: RosterRowStatus; message?: string }> {
  const { DomainAllowlistService } = await import("../../lib/services/DomainAllowlistService");
  const check = DomainAllowlistService.validateEmailDomain(normalizedEmail, allowedDomains);
  if (!check.allowed) {
    return {
      status: check.reason === "Invalid email format" ? "invalid_email" : "disallowed_domain",
      message: check.reason,
    };
  }

  const { members } = await listCourseRoster(db, scope, cipher, { search: normalizedEmail });
  const existing = members.find((m) => m.email === normalizedEmail);
  if (!existing) return { status: "added" };
  if (existing.status === "dropped") return { status: "restored" };
  if (existing.role !== role) {
    return {
      status: "role_conflict",
      message: `Already on this course as ${existing.role}. Would not be changed.`,
    };
  }
  return { status: "already_enrolled" };
}

function toRowStatus(status: ProvisionResult["status"]): RosterRowStatus {
  switch (status) {
    case "added":
      return "added";
    case "restored":
      return "restored";
    case "already_enrolled":
      return "already_enrolled";
    case "role_conflict":
      return "role_conflict";
    case "invalid_email":
      return "invalid_email";
    case "disallowed_domain":
      return "disallowed_domain";
  }
}

/** #32: removes someone from the course. Soft -- the row survives because
 *  submissions, grades and audit events reference it. */
export async function removeRosterMemberHandler(c: Context<AppEnv>) {
  const ctx = await instructorScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  const membershipId = c.req.param("membershipId");
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return c.json({ error: "That person is no longer on this course." }, 404);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const result = await removeCourseMember(db, ctx.scope, membershipId);
  if (result.outcome === "not_found") {
    return c.json({ error: "That person is no longer on this course." }, 404);
  }
  if (result.outcome === "is_instructor") {
    // 409: entitled, but the course's state does not permit it. A course
    // with no instructor has nobody who can add one back -- and this route
    // is reachable by an instructor on their own membership.
    return c.json(
      { error: "Instructors cannot be removed from a course here. Contact your program administrator." },
      409,
    );
  }

  try {
    const orgScope = await getOrgScopeForCourse(db, ctx.courseId);
    await auditBestEffort(db, orgScope ? [orgScope] : [], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.ROSTER_MEMBER_REMOVED,
      targetType: AUDIT_TARGET_TYPES.USER,
      targetId: result.userId,
      requestMetadata: { courseId: ctx.courseId, membershipId: result.membershipId },
    });
  } catch (err) {
    logServerError("removeRosterMemberHandler", err);
  }

  return c.json({ membershipId: result.membershipId });
}

/** Best-effort (#147), scoped to the course's org rather than fanned out
 *  (SEC-002). Only writes that changed something are events. */
async function auditRoster(
  c: Context<AppEnv>,
  ctx: { scope: CourseScope; courseId: string; authContext: AuthContext },
  result: ProvisionResult,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (result.status !== "added" && result.status !== "restored") return;
  try {
    const db = makeDb(c.env.DATABASE_URL);
    const orgScope = await getOrgScopeForCourse(db, ctx.courseId);
    await auditBestEffort(db, orgScope ? [orgScope] : [], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.ROSTER_MEMBER_ADDED,
      targetType: AUDIT_TARGET_TYPES.USER,
      // The membership, not the address: a raw email in an org-scoped audit
      // log is directly identifying, and the membership resolves to the
      // person for anyone entitled to look.
      targetId: result.membershipId ?? ctx.courseId,
      requestMetadata: { courseId: ctx.courseId, membershipId: result.membershipId, ...metadata },
    });
  } catch (err) {
    logServerError("auditRoster", err);
  }
}
