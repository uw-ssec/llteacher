import { describe, it, expect } from "vitest";
// Imported via the dedicated subpath export (not the package's main "."
// barrel) so this Worker-side file doesn't pull DOM-dependent components
// like Composer.tsx into a WebWorker-lib compilation (see
// tsconfig.worker.json, which has no DOM lib).
import {
  COURSE_ROLES,
  AUTHOR_ROLES,
  GRADER_ROLES,
  CONSOLE_ROLES,
} from "@llteacher/ui/auth/courseRole";
import { courseRoleEnum } from "../db/schema/identity";

describe("course role vocabulary parity", () => {
  it("keeps @llteacher/ui's COURSE_ROLES in sync with the course_role Postgres enum", () => {
    // apps/admin can't import this server-side Drizzle schema across the
    // app boundary, so packages/ui/src/auth/courseRole.ts hand-mirrors the
    // enum values instead. This guards against the two drifting apart.
    expect([...COURSE_ROLES].sort()).toEqual([...courseRoleEnum.enumValues].sort());
  });

  // #172: the tiers gate authoring and grading in both apps. These assertions
  // are why the tiers live in @llteacher/ui rather than being hand-mirrored:
  // a role added to the enum without being tiered now fails the build instead
  // of silently defaulting to no authority in one app and some in the other.
  it("draws every tier from the shared vocabulary", () => {
    for (const role of [...AUTHOR_ROLES, ...GRADER_ROLES, ...CONSOLE_ROLES]) {
      expect(COURSE_ROLES).toContain(role);
    }
  });

  it("keeps AUTHOR_ROLES a strict subset of GRADER_ROLES", () => {
    // Every author must be able to read the student work they set. The
    // reverse must not hold, or the grader tier is meaningless.
    for (const role of AUTHOR_ROLES) expect(GRADER_ROLES).toContain(role);
    expect(GRADER_ROLES.length).toBeGreaterThan(AUTHOR_ROLES.length);
  });

  it("tiers every role in the enum exactly once, so a new role can't be forgotten", () => {
    // A role is either an authority tier member or explicitly unprivileged.
    // Adding one to course_role without deciding which fails here.
    const UNPRIVILEGED: readonly string[] = ["student", "observer"];
    for (const role of COURSE_ROLES) {
      const tiered = (GRADER_ROLES as readonly string[]).includes(role);
      const unprivileged = UNPRIVILEGED.includes(role);
      expect(
        tiered !== unprivileged,
        `role "${role}" must be either in GRADER_ROLES or listed as unprivileged, not both or neither`,
      ).toBe(true);
    }
  });
});
