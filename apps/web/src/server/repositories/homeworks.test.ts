import { describe, it, expect, vi } from "vitest";
import { listHomeworksForCourse, createHomework } from "./homeworks";
import { unsafeCourseScope } from "./scope";
import type { Db } from "../../db/client";

describe("homeworks repository", () => {
  it("listHomeworksForCourse queries by the given course scope", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "hw1" }]);
    const db = { query: { homeworks: { findMany } } } as unknown as Db;

    const result = await listHomeworksForCourse(db, unsafeCourseScope("course-a"));

    expect(result).toEqual([{ id: "hw1" }]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("createHomework inserts with the scope as courseId", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "hw-new" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const result = await createHomework(db, unsafeCourseScope("course-a"), {
      createdById: "membership-1",
      title: "New HW",
      description: "desc",
      dueDate: new Date("2026-12-01"),
    });

    expect(result).toEqual({ id: "hw-new" });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: "course-a", createdById: "membership-1", title: "New HW" }),
    );
  });
});
