import { eq, sql } from "drizzle-orm";
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
        columns: { id: true },
      });
      if (!user) {
        const [created] = await tx.insert(users).values({
          id: crypto.randomUUID(),
          email: encryptedEmail,
          emailBlindIndex,
          isPending: true,
          platformInstructorGrantedAt: grantedAt,
          platformInstructorGrantedBy: actorUserId,
        }).returning({ id: users.id });
        user = created;
      } else {
        await tx.update(users).set({
          platformInstructorGrantedAt: grantedAt,
          platformInstructorGrantedBy: actorUserId,
          updatedAt: grantedAt,
        }).where(eq(users.id, user.id));
      }

      const [course] = await tx.insert(courses).values({
        id: crypto.randomUUID(),
        organizationId: organization.id,
        title: input.title,
        code: input.code,
        term: input.term,
      }).returning({ id: courses.id, title: courses.title, code: courses.code, term: courses.term });

      await tx.insert(courseMemberships).values({
        id: crypto.randomUUID(), userId: user!.id, courseId: course!.id, role: "instructor",
      });

      return { status: "created", course: course!, instructor: { userId: user!.id, email } } as const;
    });
  } catch (error) {
    if (constraintName(error) === "courses_org_code_term_uq") return { status: "duplicate_course" };
    throw error;
  }
}
