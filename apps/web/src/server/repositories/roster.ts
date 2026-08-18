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

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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


/* --------------------------------------------------------------------------
   #355: the batched provisioning path.

   `upsertCourseMember` above is the single-entry door and stays exactly as
   it is -- it is what the manual-add route calls, and one row is one row.
   What it cannot be is a loop body: each call issues two to four SEQUENTIAL
   round trips, and on Workers every `neon-http` query is a subrequest, which
   are capped per invocation (50 free, 1000 paid) and cost tens of
   milliseconds each. A 300-student CSV import -- the size #86 exists to
   serve -- issued ~900 of them and exceeded both the cap and the wall clock,
   leaving a half-written roster with no report of where it stopped.

   So the bulk path resolves the whole batch in a fixed number of queries:

     1. one SELECT for every user by blind index
     2. one INSERT for every user that does not exist
     3. one SELECT for every existing membership on this course
     4. one INSERT for the new memberships, one UPDATE for the restores

   Five queries for a thousand rows, rather than four thousand. The per-row
   OUTCOME reporting is unchanged, which is the point: #86 turns on being
   able to say which four rows of eighty were skipped, and batching must not
   collapse that into a count.
   -------------------------------------------------------------------------- */

/** Enrols a batch in a fixed number of queries, returning one result per
 *  entry in the order given.
 *
 *  Same invariants as `upsertCourseMember`, restated because they are now
 *  enforced by different statements: course scope in every WHERE, both
 *  capability flags explicitly false on create and restore, and an active
 *  membership under another role refused rather than promoted. */
export async function upsertCourseMembers(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  entries: ProvisionEntry[],
  allowedDomains: string[],
): Promise<ProvisionResult[]> {
  const results = new Map<number, ProvisionResult>();

  /* Pass 1 -- pure validation, no I/O. Rows that fail here never reach a
     query, which is also why the domain check is cheap enough to do per
     row: it is string work against a list read once by the caller. */
  const pending: { index: number; email: string; entry: ProvisionEntry }[] = [];
  for (const [index, entry] of entries.entries()) {
    const email = IdentityCipher.normalizeEmail(entry.email);
    const domainCheck = DomainAllowlistService.validateEmailDomain(email, allowedDomains);
    if (!domainCheck.allowed) {
      const malformed = domainCheck.reason === "Invalid email format";
      results.set(index, {
        email,
        status: malformed ? "invalid_email" : "disallowed_domain",
        message: domainCheck.reason,
      });
      continue;
    }
    pending.push({ index, email, entry });
  }
  if (pending.length === 0) return orderedResults(entries, results);

  /* Pass 2 -- resolve every identity in one query. The blind indexes are
     computed locally (HMAC, no I/O); the lookup is a single IN over a
     uniquely-indexed column. */
  const blindIndexes = await Promise.all(pending.map((p) => cipher.computeBlindIndex(p.email)));
  const existingUsers = await db
    .select({ id: users.id, emailBlindIndex: users.emailBlindIndex })
    .from(users)
    .where(inArray(users.emailBlindIndex, blindIndexes));
  // Keyed by hex, because a Uint8Array is not a usable Map key by value.
  const userIdByIndex = new Map(existingUsers.map((u) => [hex(u.emailBlindIndex), u.id]));

  /* Pass 3 -- create the users that do not exist, in one INSERT. */
  // Deduplicated WITHIN the batch as well as against what exists. Two
  // entries for one address both miss `userIdByIndex`, so without this they
  // would both be inserted and the second would violate
  // users_email_blind_index_uq -- failing the whole import over a repeated
  // line. The route deduplicates before calling, but the repository cannot
  // rely on a caller's discipline for an invariant the database enforces.
  const seenForCreate = new Set<string>();
  const toCreate = pending
    .map((entry, i) => ({ p: entry, blindIndex: blindIndexes[i]! }))
    .filter((candidate) => {
      const key = hex(candidate.blindIndex);
      if (userIdByIndex.has(key) || seenForCreate.has(key)) return false;
      seenForCreate.add(key);
      return true;
    });
  if (toCreate.length > 0) {
    const values = await Promise.all(
      toCreate.map(async ({ p, blindIndex }) => {
        const netid = deriveNetidForEmail(p.email);
        return {
          email: await cipher.encryptString(p.email),
          emailBlindIndex: blindIndex,
          displayName: p.entry.displayName
            ? await cipher.encryptString(p.entry.displayName)
            : null,
          ...(netid
            ? {
                netid: await cipher.encryptString(netid),
                netidBlindIndex: await cipher.computeBlindIndex(netid),
              }
            : {}),
          isPending: true,
        };
      }),
    );
    // onConflictDoNothing, then read back what conflicted.
    //
    // `users_email_blind_index_uq` is what makes an identity unique, and two
    // instructors importing overlapping rosters at the same moment can both
    // pass the lookup above and both try to insert. Without this the second
    // INSERT raises, and because it is ONE statement for the whole file that
    // takes down an import of three hundred rows over one shared address --
    // strictly worse than the per-row shape it replaced, where the same race
    // cost one row.
    //
    // Doing nothing on conflict makes the loser's insert a no-op; the
    // re-read below then finds the row the winner created, and both imports
    // succeed with the same identity. The FK from course_memberships means
    // the re-read has to happen before the memberships are written, which is
    // why it is here rather than deferred.
    const created = await db
      .insert(users)
      .values(values)
      .onConflictDoNothing({ target: users.emailBlindIndex })
      .returning({ id: users.id, emailBlindIndex: users.emailBlindIndex });
    for (const row of created) userIdByIndex.set(hex(row.emailBlindIndex), row.id);

    const stillMissing = toCreate
      .map((candidate) => candidate.blindIndex)
      .filter((blindIndex) => !userIdByIndex.has(hex(blindIndex)));
    if (stillMissing.length > 0) {
      const raced = await db
        .select({ id: users.id, emailBlindIndex: users.emailBlindIndex })
        .from(users)
        .where(inArray(users.emailBlindIndex, stillMissing));
      for (const row of raced) userIdByIndex.set(hex(row.emailBlindIndex), row.id);
    }
  }

  /* Pass 4 -- one lookup for every existing membership on this course. */
  const userIds = pending
    .map((_entry, i) => userIdByIndex.get(hex(blindIndexes[i]!)))
    .filter((id): id is string => id !== undefined);
  const existingMemberships =
    userIds.length > 0
      ? await db
          .select({
            id: courseMemberships.id,
            userId: courseMemberships.userId,
            role: courseMemberships.role,
            droppedAt: courseMemberships.droppedAt,
          })
          .from(courseMemberships)
          .where(
            and(eq(courseMemberships.courseId, scope), inArray(courseMemberships.userId, userIds)),
          )
      : [];
  const membershipByUser = new Map(existingMemberships.map((m) => [m.userId, m]));

  /* Pass 5 -- classify, then write each class in one statement. */
  const toInsert: { index: number; userId: string; email: string; role: CourseRole }[] = [];
  const toRestore: { index: number; membershipId: string; email: string; role: CourseRole }[] = [];

  pending.forEach((p, i) => {
    const userId = userIdByIndex.get(hex(blindIndexes[i]!));
    if (!userId) {
      // Unreachable: pass 3 created every missing user. Reported rather than
      // thrown so one impossible row cannot fail an import of 300 real ones.
      results.set(p.index, {
        email: p.email,
        status: "invalid_email",
        message: "That account could not be created.",
      });
      return;
    }
    const existing = membershipByUser.get(userId);
    if (!existing) {
      toInsert.push({ index: p.index, userId, email: p.email, role: p.entry.role });
      return;
    }
    if (existing.droppedAt === null) {
      results.set(p.index, {
        email: p.email,
        status: existing.role === p.entry.role ? "already_enrolled" : "role_conflict",
        membershipId: existing.id,
        ...(existing.role === p.entry.role ? {} : { existingRole: existing.role }),
      });
      return;
    }
    toRestore.push({ index: p.index, membershipId: existing.id, email: p.email, role: p.entry.role });
  });

  if (toInsert.length > 0) {
    // Deduplicated by user for the same reason: two entries resolving to one
    // identity would insert two memberships and violate
    // course_memberships_user_course_uq. The FIRST occurrence wins and the
    // rest are reported against the row that actually landed.
    const firstByUser = new Map<string, (typeof toInsert)[number]>();
    const duplicatesOfInsert: typeof toInsert = [];
    for (const t of toInsert) {
      if (firstByUser.has(t.userId)) duplicatesOfInsert.push(t);
      else firstByUser.set(t.userId, t);
    }
    toInsert.length = 0;
    toInsert.push(...firstByUser.values());

    const inserted = await db
      .insert(courseMemberships)
      .values(
        toInsert.map((t) => ({
          userId: t.userId,
          courseId: scope,
          role: t.role,
          canViewSolutions: false,
          canViewDrafts: false,
        })),
      )
      .returning({ id: courseMemberships.id, userId: courseMemberships.userId });
    const idByUser = new Map(inserted.map((r) => [r.userId, r.id]));
    for (const t of toInsert) {
      results.set(t.index, {
        email: t.email,
        status: "added",
        membershipId: idByUser.get(t.userId),
      });
    }
    // A repeat of an address added earlier in the same batch: the person IS
    // on the course, so `already_enrolled` is the honest report -- they were
    // not added twice, and calling it an error would be wrong.
    for (const t of duplicatesOfInsert) {
      results.set(t.index, {
        email: t.email,
        status: "already_enrolled",
        membershipId: idByUser.get(t.userId),
      });
    }
  }

  // Restores are grouped by role so each group is one UPDATE. A CSV rarely
  // mixes roles among restored rows, so this is usually a single statement;
  // the grouping is what keeps it bounded when it does.
  const restoresByRole = new Map<CourseRole, typeof toRestore>();
  for (const t of toRestore) {
    const group = restoresByRole.get(t.role) ?? [];
    group.push(t);
    restoresByRole.set(t.role, group);
  }
  for (const [role, group] of restoresByRole) {
    await db
      .update(courseMemberships)
      .set({
        role,
        droppedAt: null,
        droppedReason: null,
        canViewSolutions: false,
        canViewDrafts: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(courseMemberships.courseId, scope),
          inArray(
            courseMemberships.id,
            group.map((t) => t.membershipId),
          ),
        ),
      );
    for (const t of group) {
      results.set(t.index, { email: t.email, status: "restored", membershipId: t.membershipId });
    }
  }

  return orderedResults(entries, results);
}

/** #355: what `upsertCourseMembers` WOULD do, without writing.
 *
 *  Shares passes 1, 2 and 4 with the write path -- same validation, same
 *  identity lookup, same membership lookup -- and stops before the inserts.
 *  Two queries for a whole file.
 *
 *  Sharing the classification is the point rather than an optimization: a
 *  separate validator is free to disagree with the real path, and the
 *  disagreement only ever shows up as a commit that did something the
 *  preview did not promise. The one thing it cannot know is whether the
 *  roster changes between the preview and the commit, which is a race the
 *  instructor can see in the committed result. */
export async function previewCourseMembers(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  entries: ProvisionEntry[],
  allowedDomains: string[],
): Promise<ProvisionResult[]> {
  const results = new Map<number, ProvisionResult>();

  const pending: { index: number; email: string; entry: ProvisionEntry }[] = [];
  for (const [index, entry] of entries.entries()) {
    const email = IdentityCipher.normalizeEmail(entry.email);
    const domainCheck = DomainAllowlistService.validateEmailDomain(email, allowedDomains);
    if (!domainCheck.allowed) {
      const malformed = domainCheck.reason === "Invalid email format";
      results.set(index, {
        email,
        status: malformed ? "invalid_email" : "disallowed_domain",
        message: domainCheck.reason,
      });
      continue;
    }
    pending.push({ index, email, entry });
  }
  if (pending.length === 0) return orderedResults(entries, results);

  const blindIndexes = await Promise.all(pending.map((p) => cipher.computeBlindIndex(p.email)));
  const existingUsers = await db
    .select({ id: users.id, emailBlindIndex: users.emailBlindIndex })
    .from(users)
    .where(inArray(users.emailBlindIndex, blindIndexes));
  const userIdByIndex = new Map(existingUsers.map((u) => [hex(u.emailBlindIndex), u.id]));

  const userIds = [...userIdByIndex.values()];
  const existingMemberships =
    userIds.length > 0
      ? await db
          .select({
            id: courseMemberships.id,
            userId: courseMemberships.userId,
            role: courseMemberships.role,
            droppedAt: courseMemberships.droppedAt,
          })
          .from(courseMemberships)
          .where(
            and(eq(courseMemberships.courseId, scope), inArray(courseMemberships.userId, userIds)),
          )
      : [];
  const membershipByUser = new Map(existingMemberships.map((m) => [m.userId, m]));

  pending.forEach((p, i) => {
    const userId = userIdByIndex.get(hex(blindIndexes[i]!));
    const existing = userId ? membershipByUser.get(userId) : undefined;
    if (!existing) {
      results.set(p.index, { email: p.email, status: "added" });
      return;
    }
    if (existing.droppedAt !== null) {
      results.set(p.index, { email: p.email, status: "restored", membershipId: existing.id });
      return;
    }
    results.set(p.index, {
      email: p.email,
      status: existing.role === p.entry.role ? "already_enrolled" : "role_conflict",
      membershipId: existing.id,
      ...(existing.role === p.entry.role ? {} : { existingRole: existing.role }),
    });
  });

  return orderedResults(entries, results);
}

/** One result per input entry, in input order, so a caller can zip results
 *  back onto the CSV rows they came from by position. */
function orderedResults(
  entries: ProvisionEntry[],
  results: Map<number, ProvisionResult>,
): ProvisionResult[] {
  return entries.map(
    (entry, index) =>
      results.get(index) ?? {
        email: IdentityCipher.normalizeEmail(entry.email),
        status: "invalid_email" as const,
        message: "That row could not be processed.",
      },
  );
}

/** Blind indexes are Uint8Arrays; Map keys them by identity, not value, so
 *  every lookup would miss. Hex is the cheapest stable string form. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
