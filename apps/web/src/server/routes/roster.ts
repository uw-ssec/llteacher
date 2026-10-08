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
import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { parseRosterCsv } from "../../lib/csv";
import {
  allowedDomainsForCourse,
  listCourseRoster,
  previewCourseMembers,
  removeCourseMember,
  upsertCourseMember,
  upsertCourseMembers,
  type CourseRole,
  type ProvisionResult,
} from "../repositories/roster";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { RosterImportRowPayload, RosterListPayload, RosterRowStatus } from "@llteacher/ui/api";
import { BadRequest, Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler, requireCourseAccess, type CourseAccess } from "../effect/http";
import { query } from "../effect/services";

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

/** Instructor-of-course, then the CourseScope for that course. Both refusals
 *  carry the same body, as they always have. */
function instructorScope(c: Context<AppEnv>): Effect.Effect<CourseAccess, Forbidden> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  return authContext && courseId && authContext.isInstructorOf(courseId)
    ? requireCourseAccess(c, "courseId", "Instructor access denied")
    : Effect.fail(new Forbidden({ message: "Instructor access denied" }));
}

/** The cipher keys are process configuration, not request input: a missing
 *  key is a deployment fault, answered as a logged 503 defect. */
const identityCipher = (c: Context<AppEnv>) =>
  Effect.promise(() => loadIdentityCipherKeys(c.env)).pipe(Effect.map((keys) => new IdentityCipher(keys)));

const invalidJson = () => new BadRequest({ message: "Request body must be valid JSON" });

export const listRosterHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorScope(c);

  const search = c.req.query("search") ?? undefined;
  const cipher = yield* identityCipher(c);
  const { members, total } = yield* query(
    "listCourseRoster",
    (db) => listCourseRoster(db, ctx.scope, cipher, { search }),
  );
  const body: RosterListPayload = { members, total };
  return c.json(body);
}));

/** #32: manual add -- one address, one membership. The single-entry door to
 *  the same pipeline the CSV importer uses in bulk. */
export const addRosterMemberHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorScope(c);

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<{ email?: unknown; displayName?: unknown; role?: unknown }>(),
    catch: invalidJson,
  });
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return yield* new BadRequest({ message: "Enter an email address." });
  const role = parseRole(typeof body.role === "string" ? body.role : undefined);
  if (!role) {
    return yield* new BadRequest({ message: `Role must be one of: ${ENROLLABLE_ROLES.join(", ")}.` });
  }

  const cipher = yield* identityCipher(c);
  const allowedDomains = yield* query("allowedDomainsForCourse", (db) => allowedDomainsForCourse(db, ctx.scope));
  const result = yield* query("upsertCourseMember", (db) => upsertCourseMember(
    db,
    ctx.scope,
    cipher,
    {
      email,
      displayName: typeof body.displayName === "string" ? body.displayName.trim() : undefined,
      role: role as CourseRole,
    },
    allowedDomains,
  ));

  if (result.status === "invalid_email" || result.status === "disallowed_domain") {
    return yield* new BadRequest({ message: result.message ?? "That email address cannot be enrolled." });
  }
  if (result.status === "role_conflict") {
    return yield* new Conflict({
      message: `That person is already on this course as ${result.existingRole}. Remove them first if you need to change their role.`,
    });
  }

  yield* auditRoster(ctx, result, { role });
  return c.json(result, result.status === "already_enrolled" ? 200 : 201);
}));

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
export const importRosterHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorScope(c);

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<{ csv?: unknown; preview?: unknown }>(),
    catch: invalidJson,
  });
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) return yield* new BadRequest({ message: "Choose a CSV file to import." });
  if (csv.length > MAX_IMPORT_BYTES) {
    return yield* new BadRequest({ message: "That file is too large. Roster files are text, not spreadsheets." });
  }
  // Defaults to a preview. Getting this wrong in the safe direction means an
  // instructor sees rows they must confirm; getting it wrong the other way
  // means a file is written when they only meant to look at it.
  const preview = body.preview !== false;

  const parsed = parseRosterCsv(csv);
  if (parsed.error) return yield* new BadRequest({ message: parsed.error });
  if (parsed.rows.length === 0) {
    return yield* new BadRequest({ message: "That file has a header but no rows." });
  }

  const cipher = yield* identityCipher(c);
  const allowedDomains = yield* query("allowedDomainsForCourse", (db) => allowedDomainsForCourse(db, ctx.scope));

  /* #355: the whole file is classified in one pass and then resolved in a
     FIXED number of queries, rather than a query per row.
     `upsertCourseMembers` documents why; the shape here is that this loop
     does only local work -- parsing, deduplication, role validation -- and
     hands everything that survives to one batched call.

     Preview and commit run the same classification. They differ in one
     statement: preview asks the batch path what it WOULD do (a read), commit
     lets it write. That is what keeps the promise honest -- the rows an
     instructor confirms come from the code that will write them. */
  const rows: RosterImportRowPayload[] = [];
  const batch: { rowIndex: number; entry: { email: string; displayName?: string; role: CourseRole } }[] = [];
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

    // Placeholder, replaced below once the batch resolves. Pushed now so the
    // rows array stays in file order without a second sort.
    rows.push({ ...base, status: "added" });
    batch.push({
      rowIndex: rows.length - 1,
      entry: {
        email: rawEmail,
        displayName: name || undefined,
        role: role as CourseRole,
      },
    });
  }

  if (batch.length > 0) {
    const outcomes = preview
      ? yield* query("previewCourseMembers", (db) => previewCourseMembers(
          db,
          ctx.scope,
          cipher,
          batch.map((b) => b.entry),
          allowedDomains,
        ))
      : yield* query("upsertCourseMembers", (db) => upsertCourseMembers(
          db,
          ctx.scope,
          cipher,
          batch.map((b) => b.entry),
          allowedDomains,
        ));

    outcomes.forEach((result, i) => {
      const target = batch[i]!;
      rows[target.rowIndex] = {
        ...rows[target.rowIndex]!,
        status: toRowStatus(result.status),
        membershipId: result.membershipId,
        message:
          result.status === "role_conflict"
            ? `Already on this course as ${result.existingRole}. ${preview ? "Would not be changed." : "Not changed."}`
            : result.message,
      };
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
    yield* courseAudit("importRosterHandler", ctx.courseId, {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.ROSTER_IMPORTED,
      targetType: AUDIT_TARGET_TYPES.COURSE,
      targetId: ctx.courseId,
      requestMetadata: { added, restored, failed, rows: rows.length },
    });
  }

  return c.json({ rows, preview, added, restored, failed });
}));

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
export const removeRosterMemberHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorScope(c);

  const membershipId = c.req.param("membershipId");
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return yield* new NotFound({ message: "That person is no longer on this course." });
  }

  const result = yield* query("removeCourseMember", (db) => removeCourseMember(db, ctx.scope, membershipId));
  if (result.outcome === "not_found") {
    return yield* new NotFound({ message: "That person is no longer on this course." });
  }
  if (result.outcome === "is_instructor") {
    // 409: entitled, but the course's state does not permit it. A course
    // with no instructor has nobody who can add one back -- and this route
    // is reachable by an instructor on their own membership.
    return yield* new Conflict({
      message: "Instructors cannot be removed from a course here. Contact your program administrator.",
    });
  }

  yield* courseAudit("removeRosterMemberHandler", ctx.courseId, {
    actorUserId: ctx.authContext.session.userId,
    action: AUDIT_ACTIONS.ROSTER_MEMBER_REMOVED,
    targetType: AUDIT_TARGET_TYPES.USER,
    targetId: result.userId,
    requestMetadata: { courseId: ctx.courseId, membershipId: result.membershipId },
  });

  return c.json({ membershipId: result.membershipId });
}));

/** One audit event against the course's own org (SEC-002). Best-effort
 *  (#147): a failure -- resolving the org or writing the row -- is logged
 *  and never fails a roster change that already happened. */
function courseAudit(where: string, courseId: string, input: Parameters<typeof auditBestEffort>[2]) {
  return Effect.gen(function* () {
    const orgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    yield* query("auditBestEffort", (db) => auditBestEffort(db, orgScope ? [orgScope] : [], input));
  }).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError(where, err.cause))));
}

/** Best-effort (#147), scoped to the course's org rather than fanned out
 *  (SEC-002). Only writes that changed something are events. */
function auditRoster(ctx: CourseAccess, result: ProvisionResult, metadata: Record<string, unknown>) {
  if (result.status !== "added" && result.status !== "restored") return Effect.void;
  return courseAudit("auditRoster", ctx.courseId, {
    actorUserId: ctx.authContext.session.userId,
    action: AUDIT_ACTIONS.ROSTER_MEMBER_ADDED,
    targetType: AUDIT_TARGET_TYPES.USER,
    // The membership, not the address: a raw email in an org-scoped audit
    // log is directly identifying, and the membership resolves to the
    // person for anyone entitled to look.
    targetId: result.membershipId ?? ctx.courseId,
    requestMetadata: { courseId: ctx.courseId, membershipId: result.membershipId, ...metadata },
  });
}
