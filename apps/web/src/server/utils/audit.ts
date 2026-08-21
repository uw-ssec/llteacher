import type { Db } from "../../db/client";
import { recordAuditEvent } from "../repositories/auditEvents";
import type { OrgScope } from "../repositories/scope";
import { logServerError } from "./errors";

/** The target_type vocabulary for audit_events (#147). Until #31 every row
 *  in this table named a user; a config change names a config, so the value
 *  lives here rather than as a literal at the call site -- which is what the
 *  original note on AUDIT_ACTIONS asked the first such handler to do.
 *
 *  target_id is a plain uuid column with no FK, so nothing at the database
 *  level ties an id to its type. Keeping the vocabulary in one place is what
 *  makes `WHERE target_type = ...` a reliable query for the #50 audit
 *  viewer. */
export const AUDIT_TARGET_TYPES = {
  USER: "user",
  /** #31: an LLM configuration. Org-level blast radius -- the default is what
   *  every course without an explicit choice runs on. */
  LLM_CONFIG: "llm_config",
  /** #86: the course itself, for events that concern a whole roster rather
   *  than one person in it. Also #91's export scope. */
  COURSE: "course",
  /** #75: one student's submitted section. */
  SUBMISSION: "submission",
} as const;

/** The action vocabulary for audit_events (#147). One place so M3+ handlers
 *  reuse these instead of ad-hoc strings drifting apart. */
export const AUDIT_ACTIONS = {
  USER_LOGIN: "user.login",
  USER_LOGOUT: "user.logout",
  USER_PROVISIONED: "user.provisioned",
  USER_DEPROVISIONED: "user.deprovisioned",
  PROFILE_UPDATED: "profile.updated",
  HOMEWORK_PUBLISHED: "homework.published",
  HOMEWORK_UNPUBLISHED: "homework.unpublished",
  HOMEWORK_HIDDEN: "homework.hidden",
  HOMEWORK_UNHIDDEN: "homework.unhidden",
  /** #172: a TA's per-course capability grant changed. Audited because it
   *  widens or narrows one person's access to student work and answer keys
   *  -- the kind of change #50's audit viewer exists to make reviewable. */
  TA_CAPABILITIES_UPDATED: "membership.ta_capabilities_updated",
  /** #210: a TA was put on a course, or restored to it after removal. Audited
   *  because it hands someone access to every student's work in that course
   *  -- the membership is the access, and the capability grant on top of it
   *  is a separate, separately-audited decision. */
  COURSE_TA_ADDED: "membership.course_ta_added",
  /** #210: a TA was removed from a course. Soft: the row survives with
   *  dropped_at set, so this event and the row it names both remain
   *  reviewable afterwards. */
  COURSE_TA_REMOVED: "membership.course_ta_removed",
  /** #31: LLM configuration lifecycle. Audited because a config decides which
   *  model every student in the organization talks to and what it is told to
   *  be -- and because the default is changeable by any instructor in the
   *  org, so "who repointed us at this model" is a question that will be
   *  asked. Deactivation rather than deletion is the sanctioned removal, so
   *  there is no delete action here. */
  LLM_CONFIG_CREATED: "llm_config.created",
  LLM_CONFIG_UPDATED: "llm_config.updated",
  LLM_CONFIG_DEACTIVATED: "llm_config.deactivated",
  /** Audited because it spends money and reaches a third-party provider,
   *  even though it persists nothing else. */
  LLM_CONFIG_TESTED: "llm_config.tested",
  /** #32/#86: roster changes. Enrolment decides who can see a course's work
   *  at all, so it is audited with the same seriousness as a capability
   *  grant. The import writes ONE event for the whole file rather than one
   *  per row -- the act is "an instructor imported a roster", and a 200-row
   *  file would otherwise bury every other event in the org's log that day. */
  ROSTER_MEMBER_ADDED: "membership.roster_member_added",
  ROSTER_MEMBER_REMOVED: "membership.roster_member_removed",
  ROSTER_IMPORTED: "membership.roster_imported",
  /** #75: a grade was recorded, or an AI draft produced. Both are audited:
   *  the grade because it is an education record a student may dispute, the
   *  draft because it spends money and sends a student's transcript to a
   *  third-party provider. The score is recorded on the event; the written
   *  feedback is not -- that is the record itself, not who-did-what. */
  GRADE_RECORDED: "grade.recorded",
  GRADE_DRAFTED: "grade.drafted",
  /** #91: an instructor exported course data. FERPA-relevant: the artifact
   *  leaves the platform's control the moment it is downloaded, so the event
   *  records the scope of what left. */
  DATA_EXPORTED: "export.created",
} as const;

/** Fans an audit write out across every org scope it's relevant to (a
 *  personal action like login/logout/profile-update can concern more than
 *  one org if the user has memberships in several) and never lets a
 *  failure propagate to the caller -- an audit-log write going down must
 *  not take the login/logout/profile-update request down with it. Logs
 *  each failure so it's not silently lost, same tradeoff #95's webhook
 *  handler makes for its own audit writes. */
export async function auditBestEffort(
  db: Db,
  scopes: OrgScope[],
  input: {
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    ip?: string;
    requestMetadata?: unknown;
  },
): Promise<void> {
  await Promise.all(
    scopes.map((scope) =>
      recordAuditEvent(db, scope, input).catch((err) => {
        logServerError("auditBestEffort", err);
      }),
    ),
  );
}
