import { describe, it, expect, expectTypeOf } from "vitest";
import { orgScope, courseScope, type OrgScope, type CourseScope } from "./scope";

describe("branded scope types", () => {
  it("orgScope() wraps a plain string into an OrgScope value equal to the input", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(orgScope(id)).toBe(id);
  });

  it("courseScope() wraps a plain string into a CourseScope value equal to the input", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(courseScope(id)).toBe(id);
  });

  it("OrgScope and CourseScope are structurally distinct at the type level", () => {
    expectTypeOf<OrgScope>().not.toEqualTypeOf<CourseScope>();
  });
});
