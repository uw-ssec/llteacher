import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, users } from "../../db/schema";
import type { CourseScope } from "./scope";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

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
