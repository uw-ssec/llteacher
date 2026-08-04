import { describe, it, expect, expectTypeOf } from "vitest";
import { unsafeOrgScope, unsafeCourseScope, courseScopeFromAuthContext, type OrgScope, type CourseScope } from "./scope";

describe("branded scope types", () => {
  it("unsafeOrgScope() wraps a plain string into an OrgScope value equal to the input", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(unsafeOrgScope(id)).toBe(id);
  });

  it("unsafeCourseScope() wraps a plain string into a CourseScope value equal to the input", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(unsafeCourseScope(id)).toBe(id);
  });

  it("OrgScope and CourseScope are structurally distinct at the type level", () => {
    expectTypeOf<OrgScope>().not.toEqualTypeOf<CourseScope>();
  });
});

describe("courseScopeFromAuthContext", () => {
  it("mints a CourseScope when the auth context reports membership", () => {
    const courseId = "33333333-3333-3333-3333-333333333333";
    const authContext = { isMemberOf: (id: string) => id === courseId };
    expect(courseScopeFromAuthContext(authContext, courseId)).toBe(courseId);
  });

  it("returns null instead of minting when the auth context reports no membership", () => {
    const authContext = { isMemberOf: () => false };
    expect(courseScopeFromAuthContext(authContext, "44444444-4444-4444-4444-444444444444")).toBeNull();
  });
});
