import type { Db } from "../../db/client";
import { recordAuditEvent } from "../repositories/auditEvents";
import type { OrgScope } from "../repositories/scope";
import { logServerError } from "./errors";

/** The action/target_type vocabulary for audit_events (#147). One place so
 *  M3+ handlers reuse these instead of ad-hoc strings drifting apart.
 *  target_type is always "user" for everything in this table so far --
 *  add a value here (not a new literal at the call site) when a handler
 *  needs to audit against a different kind of target. */
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
