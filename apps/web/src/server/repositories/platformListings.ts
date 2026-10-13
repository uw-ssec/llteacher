import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { PlatformCourseListItem, PlatformInstructorListItem } from "@llteacher/ui/api";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

export async function listPlatformCourses(db: Db, cipher: IdentityCipher): Promise<PlatformCourseListItem[]> {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
    columns: { id: true },
  });
  if (!organization) return [];

  const courseRows = await db.select({
    id: courses.id,
    title: courses.title,
    code: courses.code,
    term: courses.term,
    isActive: courses.isActive,
  }).from(courses)
    .where(eq(courses.organizationId, organization.id))
    .orderBy(desc(courses.createdAt));
  if (courseRows.length === 0) return [];

  const instructorRows = await db.select({
    courseId: courseMemberships.courseId,
    userId: users.id,
    email: users.email,
  }).from(courseMemberships)
    .innerJoin(users, eq(courseMemberships.userId, users.id))
    .where(and(
      inArray(courseMemberships.courseId, courseRows.map((course) => course.id)),
      eq(courseMemberships.role, "instructor"),
      isNull(courseMemberships.droppedAt),
    ));

  const instructorsByCourse = new Map<string, Array<{ userId: string; email: string }>>();
  const decryptedInstructorRows = await Promise.all(instructorRows.map(async (row) => ({
    courseId: row.courseId,
    instructor: { userId: row.userId, email: await cipher.decryptString(row.email) },
  })));
  for (const row of decryptedInstructorRows) {
    const entries = instructorsByCourse.get(row.courseId) ?? [];
    entries.push(row.instructor);
    instructorsByCourse.set(row.courseId, entries);
  }

  return courseRows.map((course) => ({
    id: course.id,
    title: course.title,
    code: course.code,
    term: course.term,
    status: course.isActive ? "active" : "inactive",
    instructors: (instructorsByCourse.get(course.id) ?? []).sort((a, b) => a.email.localeCompare(b.email)),
  }));
}

export async function listPlatformInstructors(db: Db, cipher: IdentityCipher): Promise<PlatformInstructorListItem[]> {
  const instructorRows = await db.select({
    userId: users.id,
    email: users.email,
    isPending: users.isPending,
    grantedAt: users.platformInstructorGrantedAt,
  }).from(users)
    .where(isNotNull(users.platformInstructorGrantedAt));

  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
    columns: { id: true },
  });
  const assignments = organization
    ? await db.select({ userId: courseMemberships.userId, courseId: courseMemberships.courseId, code: courses.code, term: courses.term })
      .from(courseMemberships)
      .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
      .where(and(
        eq(courses.organizationId, organization.id),
        inArray(courseMemberships.role, ["instructor", "admin"]),
        isNull(courseMemberships.droppedAt),
      ))
    : [];
  const assignedCourses = new Map<string, Map<string, { code: string; term: string }>>();
  for (const assignment of assignments) {
    const byCourse = assignedCourses.get(assignment.userId) ?? new Map<string, { code: string; term: string }>();
    byCourse.set(assignment.courseId, { code: assignment.code, term: assignment.term });
    assignedCourses.set(assignment.userId, byCourse);
  }

  const decrypted = await Promise.all(instructorRows.map(async (row) => ({
    userId: row.userId,
    email: await cipher.decryptString(row.email),
    status: row.isPending ? "pending" as const : "signed_in" as const,
    grantedAt: row.grantedAt!.toISOString(),
    assignedCourseCount: assignedCourses.get(row.userId)?.size ?? 0,
    assignedCourses: [...(assignedCourses.get(row.userId)?.values() ?? [])]
      .sort((a, b) => a.code.localeCompare(b.code) || a.term.localeCompare(b.term)),
  })));
  return decrypted.sort((a, b) => a.email.localeCompare(b.email));
}
