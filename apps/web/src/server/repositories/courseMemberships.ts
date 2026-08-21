import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, users } from "../../db/schema";
import type { CourseScope } from "./scope";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { emailForNetid, isValidNetid } from "../../lib/netid";
import { allowedDomainsForCourse, upsertCourseMember } from "./roster";

/** The stored grant on one TA membership. The PATCH echo returns exactly
 *  this -- no identity, because the caller already knows who they edited and
 *  decrypting to answer a write would be gratuitous PII handling. */
export interface TaCapabilityGrant {
  membershipId: string;
  userId: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

/** A grant plus the decrypted identity the instructor-facing list needs.
 *  #172 audit (USE-001): the list previously shipped a raw UUID, which made
 *  its whole task -- granting the answer key to a *named person* --
 *  uncompletable, since nothing else in the product maps a membership id to
 *  a human. */
export interface CourseTaCapabilities extends TaCapabilityGrant {
  displayName: string;
  email: string;
  /** #210: true for a TA added by NetID who has never logged in, so the
   *  console can tell "waiting for them to sign in" apart from "something is
   *  wrong". Before #210 no path created a pending `ta`, so this was always
   *  false and the distinction did not exist. */
  isPending: boolean;
}

/** Lists the course's non-dropped TA memberships. Course-scoped, never
 *  org-scoped: the caller is authorized on one course, so the query is
 *  constrained by the same key (#174's lesson). */
export async function listCourseTas(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
): Promise<CourseTaCapabilities[]> {
  // Flat select+join, never a relational `with:` traversal -- Drizzle's
  // relational builder serializes bytea through JSON, which hands
  // encryptedText.fromDriver a hex string instead of a Buffer. The same
  // hazard is documented at length in repositories/submissions.ts, which
  // decrypts the student roster the same way.
  const rows = await db
    .select({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      displayName: users.displayName,
      email: users.email,
      isPending: users.isPending,
      canViewSolutions: courseMemberships.canViewSolutions,
      canViewDrafts: courseMemberships.canViewDrafts,
    })
    .from(courseMemberships)
    .innerJoin(users, eq(courseMemberships.userId, users.id))
    .where(
      and(
        eq(courseMemberships.courseId, scope),
        eq(courseMemberships.role, "ta"),
        isNull(courseMemberships.droppedAt),
      ),
    )
    // #189 (#172 re-audit, USE-028): explicitly ordered. setTaCapabilities
    // issues an UPDATE, and under MVCC that writes a new tuple -- so without
    // an ORDER BY the TA an instructor just edited can move position on the
    // next fetch, and TaCapabilitiesView refetches on any 404 save and on
    // every remount. Same class of defect as SCL-001/FUN-103 in
    // ProfileService: an unordered query feeding a UI that treats row
    // position as meaningful.
    //
    // Sorted on the ENCRYPTED email column, so this is a stable arbitrary
    // order rather than an alphabetical one -- ciphertext does not collate
    // like plaintext, and the plaintext only exists after the decrypt pass
    // below. Stability is what this fixes; presentation order is the
    // client's to choose, and TaCapabilitiesView sorts by display name.
    .orderBy(users.email, courseMemberships.id);

  // Promise.all over the rows. To be accurate about why: IdentityCipher's
  // decryptString is CPU-bound WebCrypto on a single-threaded runtime, so
  // this does NOT make the decryptions run in parallel -- an earlier version
  // of this comment claimed it did, contrasting it with the submissions
  // dashboard's serial await. It is written this way because it reads
  // better than an accumulating for-loop, and because a TA roster is small
  // enough (single digits per course) that the distinction does not matter
  // either way. If roster decryption ever shows up in a profile, the fix is
  // to stop decrypting per row, not to re-shape this loop.
  return Promise.all(
    rows.map(async (r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      displayName: r.displayName ? await cipher.decryptString(r.displayName) : "",
      email: await cipher.decryptString(r.email),
      isPending: r.isPending,
      canViewSolutions: r.canViewSolutions,
      canViewDrafts: r.canViewDrafts,
    })),
  );
}

/** Sets one or both capability flags on a TA membership.
 *
 *  The `role = 'ta'` and `courseId = scope` predicates are part of the WHERE,
 *  not a read-then-write check, so a membership in another course -- or an
 *  instructor's own membership -- simply matches zero rows and returns null
 *  rather than being updated. That closes the same authorize-on-one-key /
 *  write-by-another gap #174 found on the read side, and avoids a
 *  check-then-act race.
 *
 *  Returns null when no such TA membership exists in this course; the route
 *  maps that to 404. Only the flags named in `input` are written, so a
 *  partial update never silently clears the other capability. */
export async function setTaCapabilities(
  db: Db,
  scope: CourseScope,
  membershipId: string,
  input: { canViewSolutions?: boolean; canViewDrafts?: boolean },
): Promise<TaCapabilityGrant | null> {
  const fields = {
    ...(input.canViewSolutions !== undefined && { canViewSolutions: input.canViewSolutions }),
    ...(input.canViewDrafts !== undefined && { canViewDrafts: input.canViewDrafts }),
  };
  // #172 audit (FUN-005): the route rejects a body naming neither flag with
  // a 400, so this is unreachable in production. An earlier version handled
  // it with a read-back branch -- a second SELECT and ~20 lines that no
  // caller could reach, kept alive only by a test written for it. Throwing
  // states the precondition instead of quietly succeeding with a no-op.
  if (Object.keys(fields).length === 0) {
    throw new Error("setTaCapabilities requires at least one capability flag");
  }

  const [updated] = await db
    .update(courseMemberships)
    .set({ ...fields, updatedAt: new Date() })
    .where(
      and(
        eq(courseMemberships.id, membershipId),
        eq(courseMemberships.courseId, scope),
        eq(courseMemberships.role, "ta"),
        isNull(courseMemberships.droppedAt),
      ),
    )
    .returning({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      canViewSolutions: courseMemberships.canViewSolutions,
      canViewDrafts: courseMemberships.canViewDrafts,
    });
  return updated ?? null;
}

/* --------------------------------------------------------------------------
   #210: adding and removing course TAs by NetID.

   Before this, nothing in the product put a TA on a course. The TA
   permissions page (#172) grants capabilities to TAs who are already
   enrolled, so for a course with no TAs it was a dead end -- an instructor
   had no next action anywhere in the console (#192).
   -------------------------------------------------------------------------- */

/** One entered NetID's outcome. Per-NetID rather than one collective
 *  pass/fail because bulk entry with a single "failed" is unusable when
 *  three of eight NetIDs were typos and the instructor cannot tell which.
 *
 *  On `added` vs `restored` (#210's second open question): the distinction
 *  is kept. It tells an authorized instructor whether to expect the person
 *  to log in for the first time or to already have an account -- which is
 *  the difference between "waiting on them" and "something is wrong". It
 *  does leak, to someone who is already course staff adding their own TAs,
 *  whether a given NetID has ever used LLteacher. That is a deliberate
 *  trade, recorded here rather than arrived at by accident. */
export type AddTaStatus =
  /** No user existed: a pending user and an active `ta` membership. */
  | "added"
  /** A dropped membership was restored to `ta`, both grants cleared. */
  | "restored"
  /** Already an active TA of this course. No write. */
  | "already_ta"
  /** Not a well-formed UW NetID; nothing was created. See lib/netid.ts. */
  | "invalid_netid"
  /** Active membership in this course under another role. Refused rather
   *  than promoted -- see the comment on the branch below. */
  | "role_conflict";

export interface AddTaResult {
  netid: string;
  status: AddTaStatus;
  membershipId?: string;
  /** Present for `role_conflict`, so the instructor is told what the person
   *  already is rather than just that it did not work. */
  existingRole?: string;
}

/** Adds TAs to a course by UW NetID, one independent outcome per entry.
 *
 *  #86's rule -- manual add, CSV import and NetID entry must be ONE
 *  provisioning pipeline -- means this is now an adapter rather than a
 *  second implementation. It does the two things that are genuinely
 *  NetID-specific (validate the format, derive the address) and hands the
 *  rest to `upsertCourseMember`, which owns the upsert semantics, the
 *  capability-flag clearing and the role-conflict rule for every caller.
 *
 *  An earlier version of this function duplicated that logic. The duplicate
 *  was correct on the day it was written, which is exactly the state from
 *  which two implementations drift.
 *
 *  The status vocabulary stays NetID-shaped (`already_ta`, `invalid_netid`)
 *  because that is what the admin panel renders and what #210 specifies;
 *  the mapping from the shared vocabulary is the last thing this does. */
export async function addTasByNetid(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  netids: string[],
): Promise<AddTaResult[]> {
  const results: AddTaResult[] = [];
  // Deduplicated after normalization: pasting a list twice, or with a
  // trailing blank line, should not produce two rows of results for one
  // person -- and the second pass would report `already_ta` for a NetID the
  // first pass had just added, which reads as a contradiction.
  const seen = new Set<string>();

  // Read once for the whole batch rather than per entry: a 100-NetID paste
  // would otherwise issue 100 identical queries for a value that cannot
  // change mid-request.
  const allowedDomains = await allowedDomainsForCourse(db, scope);

  for (const raw of netids) {
    const netid = IdentityCipher.normalizeNetid(raw);
    if (netid === "" || seen.has(netid)) continue;
    seen.add(netid);

    if (!isValidNetid(netid)) {
      results.push({ netid, status: "invalid_netid" });
      continue;
    }

    const provisioned = await upsertCourseMember(
      db,
      scope,
      cipher,
      { email: emailForNetid(netid), role: "ta" },
      allowedDomains,
    );

    switch (provisioned.status) {
      case "added":
      case "restored":
        results.push({ netid, status: provisioned.status, membershipId: provisioned.membershipId });
        break;
      case "already_enrolled":
        results.push({ netid, status: "already_ta", membershipId: provisioned.membershipId });
        break;
      case "role_conflict":
        results.push({
          netid,
          status: "role_conflict",
          existingRole: provisioned.existingRole,
        });
        break;
      // A NetID that passed isValidNetid always yields a well-formed
      // `netid@uw.edu`, so these are only reachable if an organization's
      // allowlist excludes uw.edu -- a real configuration, and one an
      // instructor should be told about rather than see as a silent no-op.
      case "invalid_email":
      case "disallowed_domain":
        results.push({ netid, status: "invalid_netid" });
        break;
    }
  }

  return results;
}

/** Removes a TA from a course. Soft: sets dropped_at + dropped_reason and
 *  never deletes the row, because submissions, grades and audit history
 *  reference the membership id.
 *
 *  Clears both capability flags, for the reason SEC-006 gives and 0027 now
 *  enforces: `listCourseTas` filters `dropped_at IS NULL`, so a grant left on
 *  a dropped row is invisible on the only page that can revoke it. (Since
 *  #207 the database rejects the write that would leave one, so this is the
 *  statement that keeps the removal legal, not merely tidy.)
 *
 *  Returns null when no such active TA membership exists in this course --
 *  covering "no such id", "belongs to another course", "not a TA" and
 *  "already removed" indistinguishably, so a probing caller learns nothing.
 *  Same shape as setTaCapabilities. */
export async function removeCourseTa(
  db: Db,
  scope: CourseScope,
  membershipId: string,
): Promise<{ membershipId: string; userId: string } | null> {
  const [removed] = await db
    .update(courseMemberships)
    .set({
      droppedAt: new Date(),
      droppedReason: "roster_removal",
      canViewSolutions: false,
      canViewDrafts: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(courseMemberships.id, membershipId),
        eq(courseMemberships.courseId, scope),
        eq(courseMemberships.role, "ta"),
        isNull(courseMemberships.droppedAt),
      ),
    )
    .returning({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
    });
  return removed ?? null;
}
