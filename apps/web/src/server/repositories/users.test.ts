import { describe, it, expect, vi } from "vitest";
import { listMembershipsForUser } from "./users";
import type { Db } from "../../db/client";

describe("users repository", () => {
  it("listMembershipsForUser queries course_memberships by the given userId", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "m1", userId: "u1", courseId: "course-a", role: "instructor" }]);
    const db = { query: { courseMemberships: { findMany } } } as unknown as Db;

    const result = await listMembershipsForUser(db, "u1");

    expect(result).toEqual([{ id: "m1", userId: "u1", courseId: "course-a", role: "instructor" }]);
    expect(findMany).toHaveBeenCalledOnce();
  });
});
