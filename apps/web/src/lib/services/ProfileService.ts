import { eq, inArray } from "drizzle-orm";
import { courseMemberships, homeworks, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { IdentityCipher } from "../crypto/identity-cipher";
import type { CourseRole } from "../../server/middleware/roles";
import type { ProfileWithStats } from "../../shared/types";

/** Highest-privilege-first ordering used to derive a deterministic
 *  "primary role" for a user with multiple course memberships. Postgres
 *  gives no row-ordering guarantee without an explicit ORDER BY, so picking
 *  `memberships[0]` would make the primary role flicker across requests for
 *  any multi-role user (e.g. instructor in one course, student in another). */
const ROLE_PRIORITY: CourseRole[] = ["admin", "instructor", "ta", "student", "observer"];

export class ProfileService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async getProfileWithStats(userId: string): Promise<ProfileWithStats> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const email = await this.cipher.decryptString(user.email);
    const displayName = user.displayName
      ? await this.cipher.decryptString(user.displayName)
      : null;

    const memberships = await this.db.query.courseMemberships.findMany({
      where: eq(courseMemberships.userId, userId),
    });
    const primaryRole =
      ROLE_PRIORITY.find((role) => memberships.some((m) => m.role === role)) ?? null;

    const profile: ProfileWithStats = {
      userId: user.id,
      email,
      displayName,
      role: primaryRole,
      courseCount: memberships.length,
    };

    if (primaryRole === "instructor" || primaryRole === "ta" || primaryRole === "admin") {
      const membershipIds = memberships.map((m) => m.id);
      const createdHomeworks = membershipIds.length
        ? await this.db.query.homeworks.findMany({
            where: inArray(homeworks.createdById, membershipIds),
          })
        : [];
      profile.instructorStats = { homeworksCreated: createdHomeworks.length };
    } else if (primaryRole === "student") {
      // TODO: real submission/completion counts once the conversation +
      // submission tables land (multi-tenant-data-model.md §6.3, M2). No
      // per-student runtime data exists in the schema yet -- issues
      // #12/#13 explicitly gate this on M2. Both fields are stubbed
      // together (rather than omitting completedSections) so the response
      // type honestly reflects what M1 can compute today.
      profile.studentStats = { submissionsCount: 0, completedSections: 0 };
    }

    return profile;
  }

  async updateDisplayName(
    userId: string,
    newDisplayName: string,
  ): Promise<{ displayName: string }> {
    const encrypted = await this.cipher.encryptString(newDisplayName);
    await this.db
      .update(users)
      .set({ displayName: encrypted, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return { displayName: newDisplayName };
  }
}
