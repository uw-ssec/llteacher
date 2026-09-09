import { describe, it, expect } from "vitest";
import {
  resolveCollections,
  type CollectionAttachmentRecord,
  type ResolutionTarget,
} from "./resolveCollections";

const COURSE = "course-1";
const HOMEWORK = "hw-1";
const SECTION = "sec-1";
const CONFIG = "cfg-1";

const atCourse: CollectionAttachmentRecord = {
  collectionId: "col-course",
  scope: { kind: "course", courseId: COURSE },
};
const atHomework: CollectionAttachmentRecord = {
  collectionId: "col-homework",
  scope: { kind: "homework", homeworkId: HOMEWORK },
};
const atSection: CollectionAttachmentRecord = {
  collectionId: "col-section",
  scope: { kind: "section", sectionId: SECTION },
};
const atConfig: CollectionAttachmentRecord = {
  collectionId: "col-config",
  scope: { kind: "llmConfig", llmConfigId: CONFIG },
};

const fullTarget: ResolutionTarget = {
  courseId: COURSE,
  homeworkId: HOMEWORK,
  sectionId: SECTION,
  llmConfigId: CONFIG,
};

describe("resolveCollections", () => {
  it.each([
    ["section wins over everything", [atCourse, atHomework, atSection, atConfig], "section", ["col-section"]],
    ["homework wins when no section attachment", [atCourse, atHomework, atConfig], "homework", ["col-homework"]],
    ["course wins when no section or homework", [atCourse, atConfig], "course", ["col-course"]],
    ["llm config is the last fallback", [atConfig], "llmConfig", ["col-config"]],
    ["nothing attached resolves to none", [], "none", []],
  ])("%s", (_name, attachments, level, collectionIds) => {
    expect(resolveCollections(attachments, fullTarget)).toEqual({ level, collectionIds });
  });

  it("combines multiple collections attached at the winning level", () => {
    const second = { collectionId: "col-homework-2", scope: atHomework.scope };
    const result = resolveCollections([atCourse, atHomework, second], fullTarget);
    expect(result.level).toBe("homework");
    expect(result.collectionIds.sort()).toEqual(["col-homework", "col-homework-2"]);
  });

  it("ignores attachments scoped to a different target at the same level", () => {
    const other = {
      collectionId: "col-other-hw",
      scope: { kind: "homework", homeworkId: "hw-other" } as const,
    };
    expect(resolveCollections([atCourse, other], fullTarget)).toEqual({
      level: "course",
      collectionIds: ["col-course"],
    });
  });

  it("skips levels the target does not name", () => {
    // A course-level question: no homework, no section, no config in play.
    expect(
      resolveCollections([atSection, atHomework, atCourse], { courseId: COURSE }),
    ).toEqual({ level: "course", collectionIds: ["col-course"] });
  });

  it("deduplicates a collection attached twice at the winning level", () => {
    expect(
      resolveCollections([atHomework, { ...atHomework }], fullTarget).collectionIds,
    ).toEqual(["col-homework"]);
  });
});
