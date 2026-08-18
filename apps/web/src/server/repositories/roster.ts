/* --------------------------------------------------------------------------
   The course roster, and the ONE provisioning pipeline behind it (#32, #86).

   Three inputs create the same rows: an instructor typing one email (#32), a
   CSV upload (#86), and NetID entry on the TA page (#210) -- with a Canvas
   roster sync (#74/#11x) to come. #86 is explicit that if they do not share
   a pipeline, that is the thing to fix first. So `upsertCourseMember` below
   is the single write, and every caller is a thin adapter that translates
   its own input shape into that call and its own vocabulary out of the
   result.

   The constraint that shapes all of it is unchanged from #210:

       uniqueIndex("course_memberships_user_course_uq").on(userId, courseId)

   spans dropped rows. So enrolling somebody is an UPSERT, never an insert:
   a previously-removed student has a row waiting, and inserting a second one
   violates the index.
   -------------------------------------------------------------------------- */

import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import type { CourseScope } from "./scope";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import type { RosterMemberPayload, RosterMemberStatus } from "@llteacher/ui/api";

export type CourseRole = (typeof courseMemberships.$inferSelect)["role"];

/** What happened to one entry. Deliberately finer-grained than a boolean,
 *  and shared by every caller, so the CSV importer and the NetID form report
 *  the same distinctions rather than each inventing a vocabulary.
 *
 *  `added` vs `restored` is kept for the reason #210 records: it tells an
 *  authorized instructor whether to expect a first login or an existing
 *  account, which is the difference between "waiting on them" and "something
 *  is wrong". */
export type ProvisionStatus =
  | "added"
  | "restored"
  | "already_enrolled"
  | "role_conflict"
  | "invalid_email"
  | "disallowed_domain";

export interface ProvisionEntry {
  email: string;
  /** Optional display name, for CSV rows that carry one. Never overwrites a
   *  name the person's own login supplied -- see upsertCourseMember. */
  displayName?: string;
  role: CourseRole;
}

export interface ProvisionResult {
  email: string;
  status: ProvisionStatus;
  membershipId?: string;
  existingRole?: CourseRole;
  message?: string;
}

/** The org's allowed email domains, or the platform default when it names
 *  none. Read once per import rather than per row: a 200-row CSV would
 *  otherwise issue 200 identical queries for a value that cannot change
 *  mid-request. */
export async function allowedDomainsForCourse(db: Db, scope: CourseScope): Promise<string[]> {
  const [row] = await db
    .select({ allowedDomains: organizations.allowedDomains })
    .from(courses)
    .innerJoin(organizations, eq(courses.organizationId, organizations.id))
    .where(eq(courses.id, scope));
  const configured = row?.allowedDomains ?? [];
  return configured.length > 0 ? configured : DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS;
}

/** Enrolls or re-enrols one person on a course, creating a pending user when
 *  no account exists yet.
 *
 *  THE ONE WRITE. Manual add, CSV import and NetID entry all land here, so
 *  the invariants below hold for every input rather than for whichever one
 *  its author remembered:
 *
 *   · Course scope is in the WHERE clause, never a read-then-write check on
 *     a different key (#174).
 *   · Both TA capability flags are written false explicitly on every create
 *     and restore. Column defaults only apply on insert, so the restore path
 *     needs the statement; and #207's constraint makes a dropped row with
 *     grants unrepresentable, so a restore that forgot would be rejected
 *     rather than silently wrong.
 *   · An active membership under a DIFFERENT role is refused, not promoted.
 *     A grad student enrolled in the course they TA is a real case, and
 *     changing their role changes what they can see of their own coursework
 *     -- an instructor should do that deliberately, and the console offers no
 *     way to explain or undo it.
 *
 *  Not transactional: neon-http has no interactive transactions (the
 *  constraint UserIdentityService documents). Each entry is independent, and
 *  the only two-statement case -- create user, then create membership --
 *  leaves at worst an unreferenced pending user that the next attempt for
 *  that address finds and reuses. */
export async function upsertCourseMember(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  entry: ProvisionEntry,
  allowedDomains: string[],
): Promise<ProvisionResult> {
  const email = IdentityCipher.normalizeEmail(entry.email);

  const domainCheck = DomainAllowlistService.validateEmailDomain(email, allowedDomains);
  if (!domainCheck.allowed) {
    // The service distinguishes a malformed address from a well-formed one
    // at a domain nobody here may use; the instructor needs different
    // sentences for "you typed it wrong" and "that person is not eligible".
    const malformed = domainCheck.reason === "Invalid email format";
    return {
      email,
      status: malformed ? "invalid_email" : "disallowed_domain",
      message: domainCheck.reason,
    };
  }

  const emailBlindIndex = await cipher.computeBlindIndex(email);
  let user = await db.query.users.findFirst({
    where: eq(users.emailBlindIndex, emailBlindIndex),
    columns: { id: true },
  });

  if (!user) {
    // A pending user: no workos_user_id. createOrClaimUser claims it on the
    // person's first AuthKit login by matching this same blind index.
    const netid = deriveNetidForEmail(email);
    const [created] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(email),
        emailBlindIndex,
        displayName: entry.displayName ? await cipher.encryptString(entry.displayName) : null,
        // The NetID is derivable for UW addresses and is what the #210 admin
        // search keys on, so it is written here rather than waiting for the
        // person's first login to supply it.
        ...(netid
          ? {
              netid: await cipher.encryptString(netid),
              netidBlindIndex: await cipher.computeBlindIndex(netid),
            }
          : {}),
        isPending: true,
      })
      .returning({ id: users.id });
    user = created;
  }

  const existing = await db.query.courseMemberships.findFirst({
    where: and(eq(courseMemberships.userId, user!.id), eq(courseMemberships.courseId, scope)),
    columns: { id: true, role: true, droppedAt: true },
  });

  if (!existing) {
    const [membership] = await db
      .insert(courseMemberships)
      .values({
        userId: user!.id,
        courseId: scope,
        role: entry.role,
        canViewSolutions: false,
        canViewDrafts: false,
      })
      .returning({ id: courseMemberships.id });
    return { email, status: "added", membershipId: membership!.id };
  }

  if (existing.droppedAt === null) {
    if (existing.role === entry.role) {
      return { email, status: "already_enrolled", membershipId: existing.id };
    }
    return { email, status: "role_conflict", existingRole: existing.role, membershipId: existing.id };
  }

  const [restored] = await db
    .update(courseMemberships)
    .set({
      role: entry.role,
      droppedAt: null,
      droppedReason: null,
      canViewSolutions: false,
      canViewDrafts: false,
      updatedAt: new Date(),
    })
    .where(and(eq(courseMemberships.id, existing.id), eq(courseMemberships.courseId, scope)))
    .returning({ id: courseMemberships.id });
  return { email, status: "restored", membershipId: restored!.id };
}

/** UW NetIDs are the local part of a uw.edu (or *.uw.edu) address. Mirrors
 *  UserIdentityService's deriveNetid, which is private to that class; kept
 *  narrow here rather than exported from there, since widening a service's
 *  surface to share four lines is the worse trade. */
function deriveNetidForEmail(normalizedEmail: string): string | null {
  const domain = normalizedEmail.split("@")[1];
  if (domain === "uw.edu" || domain?.endsWith(".uw.edu")) {
    return IdentityCipher.normalizeNetid(normalizedEmail.split("@")[0] ?? "");
  }
  return null;
}

/** #32: the instructor's view of course_memberships.
 *
 *  Includes DROPPED rows, unlike every other membership read in the tree.
 *  That is deliberate and is the reason this does not reuse
 *  listMembershipsForUser: the roster is the one surface where "who used to
 *  be in this course" is the question being asked, and a removal that leaves
 *  no trace is indistinguishable from a person who was never added.
 *
 *  SEARCH, and its honest performance boundary: an exact email match goes
 *  through the blind index, which is an indexed equality on ciphertext. A
 *  name or partial match cannot -- the column is encrypted, so there is no
 *  index to use and no way to filter in SQL. Those are filtered AFTER
 *  decryption, in this function, over the whole course roster. That is fine
 *  at a course's scale (hundreds) and would not be at an organization's
 *  (tens of thousands); if this ever needs to be, the fix is a searchable
 *  derived column, not a smarter query here. */
export async function listCourseRoster(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  options: { search?: string } = {},
): Promise<{ members: RosterMemberPayload[]; total: number }> {
  const search = options.search?.trim() ?? "";
  const exactEmailIndex =
    search.includes("@") ? await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(search)) : null;

  const rows = await db
    .select({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      displayName: users.displayName,
      email: users.email,
      isPending: users.isPending,
      role: courseMemberships.role,
      enrolledAt: courseMemberships.enrolledAt,
      lastLoginAt: users.lastLoginAt,
      droppedAt: courseMemberships.droppedAt,
    })
    .from(courseMemberships)
    .innerJoin(users, eq(courseMemberships.userId, users.id))
    .where(
      exactEmailIndex
        ? and(
            eq(courseMemberships.courseId, scope),
            eq(users.emailBlindIndex, exactEmailIndex),
          )
        : eq(courseMemberships.courseId, scope),
    )
    // Explicitly ordered for the reason #189 records: an UPDATE writes a new
    // tuple under MVCC, so without an ORDER BY the row an instructor just
    // edited can move position on the next fetch. Active before dropped, then
    // by enrolment; presentation order is the client's to refine.
    .orderBy(asc(sql`(${courseMemberships.droppedAt} is not null)`), asc(courseMemberships.enrolledAt), asc(courseMemberships.id));

  // Serial rather than Promise.all: decryptString is CPU-bound WebCrypto on
  // a single-threaded runtime, so neither shape runs in parallel -- and a
  // roster is the one list here that can genuinely be hundreds long, where
  // an accumulating loop keeps peak memory to one row's plaintext rather
  // than the whole course's at once.
  const members: RosterMemberPayload[] = [];
  for (const r of rows) {
    const displayName = r.displayName ? await cipher.decryptString(r.displayName) : "";
    const email = await cipher.decryptString(r.email);
    members.push({
      membershipId: r.membershipId,
      userId: r.userId,
      displayName,
      email,
      initials: initialsFor(displayName, email),
      role: r.role,
      status: statusFor(r),
      enrolledAt: r.enrolledAt.toISOString(),
      lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
      droppedAt: r.droppedAt ? r.droppedAt.toISOString() : null,
    });
  }

  const total = members.length;
  if (!search || exactEmailIndex) return { members, total };

  // Name/partial search, post-decryption. See the performance note above.
  const needle = search.toLowerCase();
  return {
    members: members.filter(
      (m) =>
        m.displayName.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle),
    ),
    total,
  };
}

/** `pending` beats `dropped` deliberately when both could apply: a person
 *  who never signed in and was then removed is, to an instructor scanning
 *  the roster, someone who never arrived. */
function statusFor(row: { isPending: boolean; droppedAt: Date | null }): RosterMemberStatus {
  if (row.droppedAt !== null) return "dropped";
  return row.isPending ? "pending" : "active";
}

/** Display-only, derived rather than stored. Falls back to the email's local
 *  part for a pending user, who has no name until their first login. */
function initialsFor(displayName: string, email: string): string {
  const source = displayName.trim() || (email.split("@")[0] ?? "");
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** #32: removes someone from the course. Soft, like removeCourseTa and for
 *  the same reason -- submissions, grades and audit events reference the
 *  membership id, so the row must survive.
 *
 *  Refuses to remove an instructor. A course with no instructor has no one
 *  who can add one back, and this route is reachable by any instructor of
 *  the course, including on their own membership. */
export type RemoveMemberOutcome =
  | { outcome: "removed"; membershipId: string; userId: string }
  | { outcome: "not_found" }
  | { outcome: "is_instructor" };

export async function removeCourseMember(
  db: Db,
  scope: CourseScope,
  membershipId: string,
): Promise<RemoveMemberOutcome> {
  const existing = await db.query.courseMemberships.findFirst({
    where: and(eq(courseMemberships.id, membershipId), eq(courseMemberships.courseId, scope)),
    columns: { id: true, role: true, droppedAt: true },
  });
  if (!existing || existing.droppedAt !== null) return { outcome: "not_found" };
  if (existing.role === "instructor" || existing.role === "admin") {
    return { outcome: "is_instructor" };
  }

  const [removed] = await db
    .update(courseMemberships)
    .set({
      droppedAt: new Date(),
      droppedReason: "roster_removal",
      // Cleared for the SEC-006 reason, and since #207 the database rejects
      // the write that would leave them: a dropped row's grant is invisible
      // to every list and therefore unrevokable.
      canViewSolutions: false,
      canViewDrafts: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(courseMemberships.id, membershipId),
        eq(courseMemberships.courseId, scope),
        isNull(courseMemberships.droppedAt),
        // Restated in the WHERE, not just checked above: the read-then-write
        // gap is exactly what #174 found, and an instructor role arriving
        // between the two statements must not be removable.
        ne(courseMemberships.role, "instructor"),
        ne(courseMemberships.role, "admin"),
      ),
    )
    .returning({ id: courseMemberships.id, userId: courseMemberships.userId });
  return removed
    ? { outcome: "removed", membershipId: removed.id, userId: removed.userId }
    : { outcome: "not_found" };
}
