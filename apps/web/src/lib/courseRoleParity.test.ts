import { describe, it, expect } from "vitest";
// Imported via the dedicated subpath export (not the package's main "."
// barrel) so this Worker-side file doesn't pull DOM-dependent components
// like Composer.tsx into a WebWorker-lib compilation (see
// tsconfig.worker.json, which has no DOM lib).
import { COURSE_ROLES } from "@llteacher/ui/auth/courseRole";
import { courseRoleEnum } from "../db/schema/identity";

describe("course role vocabulary parity", () => {
  it("keeps @llteacher/ui's COURSE_ROLES in sync with the course_role Postgres enum", () => {
    // apps/admin can't import this server-side Drizzle schema across the
    // app boundary, so packages/ui/src/auth/courseRole.ts hand-mirrors the
    // enum values instead. This guards against the two drifting apart.
    expect([...COURSE_ROLES].sort()).toEqual([...courseRoleEnum.enumValues].sort());
  });
});
