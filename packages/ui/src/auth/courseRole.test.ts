import { describe, it, expect } from "vitest";
import { COURSE_ROLES, parseCourseRole } from "./courseRole";

describe("parseCourseRole", () => {
  it.each(COURSE_ROLES)("accepts the known role %s", (role) => {
    expect(parseCourseRole(role)).toBe(role);
  });

  it("rejects an unknown string", () => {
    expect(parseCourseRole("grader")).toBeNull();
  });

  it("rejects non-string values", () => {
    expect(parseCourseRole(null)).toBeNull();
    expect(parseCourseRole(undefined)).toBeNull();
    expect(parseCourseRole(42)).toBeNull();
  });
});
