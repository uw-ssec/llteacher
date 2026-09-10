import type { Db } from "../db/client";
import type { OrgScope } from "../server/repositories/scope";
import { AUDIT_ACTIONS, auditBestEffort } from "../server/utils/audit";
import { logServerError } from "../server/utils/errors";
import type { AuthContext } from "../server/middleware/roles";

/* --------------------------------------------------------------------------
   instructor-authz — transcript-specific authorization helpers (#29).

   #90 review finding (Important #1): recordTranscriptAccess's audit half is
   reused as-is by routes/feedback.ts's listCourseFeedbackHandler --
   browsing a course's flagged responses returns the identical class of
   student-record content (decrypted names, response text) the transcript
   list already audits, and the brief's own "don't fork a second authz
   helper" invariant applies to the audit hook exactly as much as it does to
   canReadCourseTranscripts. TranscriptAccessEvent.action grew a third
   variant ("feedback-list") rather than a new function, since nothing
   downstream branches on this module's name -- only on the AUDIT_ACTIONS
   string it writes, and FEEDBACK_LIST_VIEWED (server/utils/audit.ts) is its
   own distinct value. The module keeps its original name/doc framing below
   (still true: transcripts are still the reason this file exists), with
   this one addition layered on rather than a rename that would touch every
   existing #29 call site for no behavior change.

   Deliberately thin. The actual role-membership machinery already lives in
   two places, both already tested, and this module reimplements neither:

     - server/middleware/roles.ts's AuthContext.isGraderOf(courseId) --
       course-level "may this caller read this course's student work at
       all" (#172's GRADER_ROLES: instructor/admin/ta).
     - server/repositories/sectionConversations.ts's
       canReadSectionConversation -- per-conversation "does THIS row's
       ownership/teacher-test status let this specific viewer read it"
       (#246: widened to grader tier so the tier matches the submissions
       dashboard #29 drills in from).

   What's left, and what this module exists to hold, is the two things that
   are genuinely specific to the transcript surface and would otherwise be
   duplicated across the list and detail handlers in
   routes/instructor/transcripts.ts:

     1. canReadCourseTranscripts -- one named entry point for the course-level
        gate, instead of `authContext.isGraderOf(courseId)` hand-rolled at
        each call site (route registration in index.ts AND the handler's own
        fail-closed re-check, matching every other guarded route in this
        codebase -- see getHomeworkSubmissionsHandler's own comment on why
        the re-check exists even though requireGraderOf() already wraps it).
     2. recordTranscriptAccess -- the FERPA audit hook the issue asks for.
        Correction to this task's own brief, found while implementing: the
        brief says "M9's audit_events middleware doesn't exist yet ...
        leave a TODO hook point, not a working audit system." That premise
        turns out to be stale. `audit_events` (the table), recordAuditEvent
        (repositories/auditEvents.ts, #147) and auditBestEffort
        (server/utils/audit.ts) already exist and are already the write
        path three other handlers use today (login/logout, profile updates,
        TA capability grants) -- none of that is "M9," it's already-shipped
        M2/#147 infrastructure. What genuinely doesn't exist is a *generic,
        automatic, per-route* audit middleware -- and this function isn't
        that either; it's one named call site calling the same existing
        write path the same way its three siblings do, for a route that
        (per this issue) explicitly needs it. Building the generic
        middleware would be out of scope; calling the write path it would
        eventually sit on top of is not. See this task's own report for the
        full reasoning -- this is the one place the implementation
        deliberately does more than the brief's literal instruction, and
        it's called out there for review.
   -------------------------------------------------------------------------- */

/** #246: transcript reads are grader-tier (instructor/admin/ta) -- the same
 *  tier the submissions dashboard (#172, requireGraderOf) already uses, so a
 *  TA who can see a submission in the matrix can also open the transcript
 *  behind it. This is the *course*-level gate only; per-conversation
 *  exclusions (a grader may not read another grader's teacher-test
 *  conversation) are canReadSectionConversation's job, not this function's --
 *  see that function's own doc comment for the full rule. */
export function canReadCourseTranscripts(authContext: AuthContext, courseId: string): boolean {
  return authContext.isGraderOf(courseId);
}

export interface TranscriptAccessEvent {
  viewerId: string;
  courseId: string;
  /** Present for a single-transcript read; absent for a list read (the
   *  audit-worthy fact for a list is "this course's roster was browsed",
   *  not any one conversation). Never set for "feedback-list" -- a
   *  feedback-dashboard read has no single-conversation drill-in of its
   *  own to name; the transcript a flag links into is a SEPARATE detail
   *  read that audits itself when it's actually opened. */
  conversationId?: string;
  /** #90: "feedback-list" added alongside the original "list"/"detail" --
   *  see this module's own #90 doc comment above. */
  action: "list" | "detail" | "feedback-list";
}

/** FERPA: every transcript view is student-record access and must be
 *  audited -- see this module's own doc comment above for why this calls
 *  the real, already-shipped audit_events write path (auditBestEffort,
 *  #147) instead of the no-op the brief's literal instruction described.
 *
 *  `orgScope` is `null` when the caller could not resolve one for this
 *  course (should not happen for a course that already passed the
 *  grader-tier gate -- the row exists and organization_id is NOT NULL in
 *  the schema -- so a null here means the course was deleted in the gap
 *  between the auth check and this call, or a bug; either way it's a race,
 *  not a normal condition). This is an audit write, not the read itself --
 *  degrading to "skip the audit" rather than throwing keeps a resolution
 *  hiccup here from taking down the transcript read it would have
 *  accompanied, and the read already passed a real authorization check, so
 *  failing it over a disproportionately rare audit-side edge case would be
 *  a worse outcome than a visible gap in the log. But "skip" must not mean
 *  "skip silently" (#370): an unreachable-in-theory branch that actually
 *  fires is exactly the kind of thing that must show up loudly rather than
 *  vanish, so it's logged via logServerError -- the same
 *  log-loudly-but-don't-fail tradeoff requireGraderOf's release-gate
 *  instrumentation makes (server/utils/guards.ts, #208) -- with enough
 *  context (viewer, course, and the event's own action/conversationId) to
 *  debug the race or bug later. auditBestEffort itself never throws either
 *  way (it logs and swallows), matching every other caller's tradeoff. */
export async function recordTranscriptAccess(
  db: Db,
  orgScope: OrgScope | null,
  event: TranscriptAccessEvent,
): Promise<void> {
  if (!orgScope) {
    logServerError(
      "recordTranscriptAccess",
      new Error(
        `No org scope resolved for course ${event.courseId} -- FERPA audit skipped for ` +
          `viewer ${event.viewerId} (action: ${event.action}` +
          `${event.conversationId ? `, conversationId: ${event.conversationId}` : ""}) (#370)`,
      ),
    );
    return;
  }
  const isDetailRead = event.action === "detail" && event.conversationId !== undefined;
  // #90: "feedback-list" is its own AUDIT_ACTIONS value (FEEDBACK_LIST_VIEWED)
  // -- distinct from TRANSCRIPT_LIST_VIEWED even though both are course-
  // scoped list reads, because they name different resources being browsed
  // (see FEEDBACK_LIST_VIEWED's own doc comment, server/utils/audit.ts).
  const auditAction =
    event.action === "feedback-list"
      ? AUDIT_ACTIONS.FEEDBACK_LIST_VIEWED
      : isDetailRead
        ? AUDIT_ACTIONS.TRANSCRIPT_VIEWED
        : AUDIT_ACTIONS.TRANSCRIPT_LIST_VIEWED;
  await auditBestEffort(db, [orgScope], {
    actorUserId: event.viewerId,
    action: auditAction,
    targetType: isDetailRead ? "conversation" : "course",
    targetId: isDetailRead ? event.conversationId! : event.courseId,
  });
}
