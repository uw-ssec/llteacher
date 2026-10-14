import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import type { OrgScope } from "./scope";

export interface CourseProvisioningInput {
  instructorEmail: string;
  title: string;
  code: string;
  term: string;
}

export type CourseProvisioningResult =
  | { status: "organization_missing" }
  | { status: "duplicate_course" }
  | { status: "invalid_email"; message: string }
  | {
      status: "created";
      course: { id: string; title: string; code: string; term: string };
      instructor: { userId: string; email: string };
      organizationId: string;
      membershipId: string;
      platformInstructorGrantCreated: boolean;
    };

export type AddCourseInstructorResult =
  | { status: "course_missing" }
  | { status: "invalid_email"; message: string }
  | {
      status: "assigned";
      instructor: { userId: string; email: string };
      organizationId: string;
      membershipId: string;
      membershipAdded: boolean;
      platformInstructorGrantCreated: boolean;
    };

export type RemoveCourseInstructorsResult =
  | { status: "course_missing" }
  | { status: "invalid_selection" }
  | { status: "removed"; organizationId: string; removed: Array<{ userId: string; membershipId: string }> };

export type RevokePlatformInstructorResult =
  | { status: "instructor_missing" }
  | { status: "sole_instructor"; courses: Array<{ id: string; code: string; term: string }> }
  | {
      status: "revoked";
      userId: string;
      removed: Array<{ membershipId: string; courseId: string; organizationId: string; role: string }>;
    };

function constraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current && typeof current === "object"; i += 1) {
    const record = current as { constraint?: unknown; cause?: unknown };
    if (typeof record.constraint === "string") return record.constraint;
    current = record.cause;
  }
  return undefined;
}

/** A provisioned identity must have an email that can be claimed at login. */
export function isValidInstructorEmail(email: string): boolean {
  const [local, domain, extra] = email.split("@");
  if (!local || !domain || extra !== undefined || /\s/.test(email)) return false;
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

/** Creates all local authority for a course in one PostgreSQL transaction.
 * WorkOS is intentionally absent: authentication identities are claimed on
 * first login by the same email blind index written here. */
export async function provisionInstructorCourse(
  db: Db,
  cipher: IdentityCipher,
  actorUserId: string,
  input: CourseProvisioningInput,
): Promise<CourseProvisioningResult> {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
    columns: { id: true, allowedDomains: true },
  });
  if (!organization) return { status: "organization_missing" };

  const email = IdentityCipher.normalizeEmail(input.instructorEmail);
  const domain = DomainAllowlistService.validateEmailDomain(email, organization.allowedDomains);
  if (!domain.allowed) return { status: "invalid_email", message: domain.reason ?? "Invalid email" };

  const emailBlindIndex = await cipher.computeBlindIndex(email);
  const encryptedEmail = await cipher.encryptString(email);
  const grantedAt = new Date();
  try {
    return await db.transaction(async (tx) => {
      // Prevent two simultaneous provisions for the same address from both
      // deciding they need a new pending user.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course-provision:${email}`}))`);
      let user = await tx.query.users.findFirst({
        where: eq(users.emailBlindIndex, emailBlindIndex),
        columns: { id: true, platformInstructorGrantedAt: true },
      });
      let platformInstructorGrantCreated = false;
      if (!user) {
        const [created] = await tx.insert(users).values({
          id: crypto.randomUUID(),
          email: encryptedEmail,
          emailBlindIndex,
          isPending: true,
          platformInstructorGrantedAt: grantedAt,
          platformInstructorGrantedBy: actorUserId,
        }).onConflictDoNothing({ target: users.emailBlindIndex })
          .returning({ id: users.id, platformInstructorGrantedAt: users.platformInstructorGrantedAt });
        if (created) {
          user = created;
          platformInstructorGrantCreated = true;
        } else {
          user = await tx.query.users.findFirst({
            where: eq(users.emailBlindIndex, emailBlindIndex),
            columns: { id: true, platformInstructorGrantedAt: true },
          });
          if (!user) throw new Error("User identity conflict was not readable after insert");
        }
      }
      if (!platformInstructorGrantCreated && user.platformInstructorGrantedAt === null) {
        const [createdGrant] = await tx.update(users).set({
          platformInstructorGrantedAt: grantedAt,
          platformInstructorGrantedBy: actorUserId,
          updatedAt: grantedAt,
        }).where(and(eq(users.id, user.id), isNull(users.platformInstructorGrantedAt)))
          .returning({ id: users.id });
        platformInstructorGrantCreated = createdGrant !== undefined;
      }

      const [course] = await tx.insert(courses).values({
        id: crypto.randomUUID(),
        organizationId: organization.id,
        title: input.title,
        code: input.code,
        term: input.term,
      }).returning({ id: courses.id, title: courses.title, code: courses.code, term: courses.term });

      const membershipId = crypto.randomUUID();
      await tx.insert(courseMemberships).values({ id: membershipId, userId: user!.id, courseId: course!.id, role: "instructor" });

      return {
        status: "created",
        course: course!,
        instructor: { userId: user!.id, email },
        organizationId: organization.id,
        membershipId,
        platformInstructorGrantCreated,
      } as const;
    });
  } catch (error) {
    if (constraintName(error) === "courses_org_code_term_uq") return { status: "duplicate_course" };
    throw error;
  }
}

/** Adds or restores an instructor on an existing deployment course without
 * changing any other membership. User creation, platform access, and the
 * course membership commit together so a retry cannot leave partial access. */
export async function addInstructorToCourse(
  db: Db,
  cipher: IdentityCipher,
  actorUserId: string,
  courseId: string,
  rawEmail: string,
): Promise<AddCourseInstructorResult> {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
    columns: { id: true, allowedDomains: true },
  });
  if (!organization) return { status: "course_missing" };

  const email = IdentityCipher.normalizeEmail(rawEmail);
  if (!isValidInstructorEmail(email)) {
    return { status: "invalid_email", message: "Invalid email format" };
  }
  const domain = DomainAllowlistService.validateEmailDomain(email, organization.allowedDomains);
  if (!domain.allowed) return { status: "invalid_email", message: domain.reason ?? "Invalid email" };

  const emailBlindIndex = await cipher.computeBlindIndex(email);
  const encryptedEmail = await cipher.encryptString(email);
  return db.transaction(async (tx) => {
    const course = await tx.query.courses.findFirst({
      where: and(eq(courses.id, courseId), eq(courses.organizationId, organization.id)),
      columns: { id: true },
    });
    if (!course) return { status: "course_missing" } as const;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course-instructor:${email}`}))`);
    let user = await tx.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
      columns: { id: true, platformInstructorGrantedAt: true },
    });
    let platformInstructorGrantCreated = false;
    const now = new Date();
    if (!user) {
      const [created] = await tx.insert(users).values({
        id: crypto.randomUUID(),
        email: encryptedEmail,
        emailBlindIndex,
        isPending: true,
        platformInstructorGrantedAt: now,
        platformInstructorGrantedBy: actorUserId,
      }).onConflictDoNothing({ target: users.emailBlindIndex })
        .returning({ id: users.id, platformInstructorGrantedAt: users.platformInstructorGrantedAt });
      if (created) {
        user = created;
        platformInstructorGrantCreated = true;
      } else {
        user = await tx.query.users.findFirst({
          where: eq(users.emailBlindIndex, emailBlindIndex),
          columns: { id: true, platformInstructorGrantedAt: true },
        });
        if (!user) throw new Error("User identity conflict was not readable after insert");
      }
    }
    if (!platformInstructorGrantCreated && user.platformInstructorGrantedAt === null) {
      const [createdGrant] = await tx.update(users).set({
        platformInstructorGrantedAt: now,
        platformInstructorGrantedBy: actorUserId,
        updatedAt: now,
      }).where(and(eq(users.id, user.id), isNull(users.platformInstructorGrantedAt)))
        .returning({ id: users.id });
      platformInstructorGrantCreated = createdGrant !== undefined;
    }

    const membership = await tx.query.courseMemberships.findFirst({
      where: and(eq(courseMemberships.userId, user.id), eq(courseMemberships.courseId, course.id)),
      columns: { id: true, role: true, droppedAt: true },
    });
    if (membership && membership.role === "instructor" && membership.droppedAt === null) {
      return {
        status: "assigned",
        instructor: { userId: user.id, email },
        organizationId: organization.id,
        membershipId: membership.id,
        membershipAdded: false,
        platformInstructorGrantCreated,
      } as const;
    }

    const membershipId = membership?.id ?? crypto.randomUUID();
    if (membership) {
      await tx.update(courseMemberships).set({
        role: "instructor",
        droppedAt: null,
        droppedReason: null,
        canViewSolutions: false,
        canViewDrafts: false,
        updatedAt: now,
      }).where(eq(courseMemberships.id, membership.id));
    } else {
      await tx.insert(courseMemberships).values({
        id: membershipId,
        userId: user.id,
        courseId: course.id,
        role: "instructor",
      });
    }

    return {
      status: "assigned",
      instructor: { userId: user.id, email },
      organizationId: organization.id,
      membershipId,
      membershipAdded: true,
      platformInstructorGrantCreated,
    } as const;
  });
}

/** Soft-drops selected active instructors in one transaction. An invalid or
 * stale selection changes nothing; platform grants and other courses stay. */
export async function removeInstructorsFromCourse(
  db: Db,
  organizationId: OrgScope,
  courseId: string,
  userIds: string[],
): Promise<RemoveCourseInstructorsResult> {
  return db.transaction(async (tx) => {
    const course = await tx.query.courses.findFirst({
      where: and(eq(courses.id, courseId), eq(courses.organizationId, organizationId)),
      columns: { id: true },
    });
    if (!course) return { status: "course_missing" } as const;
    const memberships = await tx.select({ id: courseMemberships.id, userId: courseMemberships.userId })
      .from(courseMemberships)
      .where(and(
        eq(courseMemberships.courseId, courseId),
        eq(courseMemberships.role, "instructor"),
        isNull(courseMemberships.droppedAt),
        inArray(courseMemberships.userId, userIds),
      ))
      .for("update");
    if (memberships.length !== userIds.length) return { status: "invalid_selection" } as const;
    const now = new Date();
    await tx.update(courseMemberships).set({ droppedAt: now, droppedReason: null, updatedAt: now })
      .where(inArray(courseMemberships.id, memberships.map((membership) => membership.id)));
    return {
      status: "removed", organizationId,
      removed: memberships.map((membership) => ({ userId: membership.userId, membershipId: membership.id })),
    } as const;
  });
}

/** Revokes the platform grant and soft-drops every active course membership
 * in one transaction. A course must retain another active instructor or
 * course admin, so a broad platform revocation cannot orphan it. */
export async function revokePlatformInstructor(
  db: Db,
  userId: string,
): Promise<RevokePlatformInstructorResult> {
  return db.transaction(async (tx) => {
    const [instructor] = await tx.select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNotNull(users.platformInstructorGrantedAt)))
      .for("update");
    if (!instructor) return { status: "instructor_missing" } as const;

    const memberships = await tx.select({
      membershipId: courseMemberships.id,
      courseId: courseMemberships.courseId,
      organizationId: courses.organizationId,
      code: courses.code,
      term: courses.term,
      role: courseMemberships.role,
    }).from(courseMemberships)
      .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
      .where(and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)))
      .for("update");

    const authorCourseIds = memberships
      .filter((membership) => membership.role === "instructor" || membership.role === "admin")
      .map((membership) => membership.courseId);
    if (authorCourseIds.length > 0) {
      const remainingAuthors = await tx.select({
        courseId: courseMemberships.courseId,
        userId: courseMemberships.userId,
      }).from(courseMemberships)
        .where(and(
          inArray(courseMemberships.courseId, authorCourseIds),
          inArray(courseMemberships.role, ["instructor", "admin"]),
          isNull(courseMemberships.droppedAt),
        ))
        .for("update");
      const coveredCourses = new Set(
        remainingAuthors.filter((membership) => membership.userId !== userId)
          .map((membership) => membership.courseId),
      );
      const orphaned = memberships
        .filter((membership) => authorCourseIds.includes(membership.courseId) && !coveredCourses.has(membership.courseId))
        .map(({ courseId: id, code, term }) => ({ id, code, term }));
      if (orphaned.length > 0) return { status: "sole_instructor", courses: orphaned } as const;
    }

    const now = new Date();
    if (memberships.length > 0) {
      await tx.update(courseMemberships).set({
        droppedAt: now,
        droppedReason: null,
        canViewSolutions: false,
        canViewDrafts: false,
        updatedAt: now,
      }).where(inArray(courseMemberships.id, memberships.map((membership) => membership.membershipId)));
    }
    await tx.update(users).set({
      platformInstructorGrantedAt: null,
      platformInstructorGrantedBy: null,
      updatedAt: now,
    }).where(eq(users.id, userId));

    return {
      status: "revoked",
      userId,
      removed: memberships.map(({ membershipId, courseId, organizationId, role }) => ({
        membershipId,
        courseId,
        organizationId,
        role,
      })),
    } as const;
  });
}
