import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";

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

function constraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current && typeof current === "object"; i += 1) {
    const record = current as { constraint?: unknown; cause?: unknown };
    if (typeof record.constraint === "string") return record.constraint;
    current = record.cause;
  }
  return undefined;
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
