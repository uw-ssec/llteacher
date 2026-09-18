/* --------------------------------------------------------------------------
   Which collections ground a given conversation (#42).

   OVERRIDE, most-specific-wins:

       section → homework → course → llm_config

   The narrowest level carrying ANY attachment supplies the entire corpus;
   collections attached at that same level combine. This matches
   prompt_templates' existing layering (lib/prompts.ts) deliberately -- two
   different inheritance rules on two adjacent instructor-facing features is
   a support burden, not a feature.

   The llm_config level sits at the BOTTOM: a tutor persona's own knowledge
   is a fallback for when the course hierarchy says nothing, not something
   that overrides an instructor's explicit per-assignment choice.

   Pure, and deliberately so. The override chain is the rule an instructor
   will be confused by first, so it gets table-driven tests with no database
   in the way. Retrieval (#41) and the admin console's /knowledge/resolve
   endpoint call this same function, so the console cannot show one answer
   while the tutor uses another.
   -------------------------------------------------------------------------- */

export type AttachmentScope =
  | { kind: "course"; courseId: string }
  | { kind: "homework"; homeworkId: string }
  | { kind: "section"; sectionId: string }
  | { kind: "llmConfig"; llmConfigId: string };

export interface CollectionAttachmentRecord {
  collectionId: string;
  scope: AttachmentScope;
}

/** Where the question is being asked from. Fields are optional because a
 *  course-level query names no homework and a homework-level query names no
 *  section; an absent field skips that level rather than matching null. */
export interface ResolutionTarget {
  courseId: string;
  homeworkId?: string | null;
  sectionId?: string | null;
  llmConfigId?: string | null;
}

export type ResolutionLevel =
  | "section"
  | "homework"
  | "course"
  | "llmConfig"
  | "none";

export interface Resolution {
  level: ResolutionLevel;
  collectionIds: string[];
}

/** Narrowest first. Each entry says how to recognise an attachment at that
 *  level, given the target. Adding a level is one entry, not a new branch. */
function matchersFor(
  target: ResolutionTarget,
): Array<{ level: ResolutionLevel; matches: (s: AttachmentScope) => boolean }> {
  return [
    {
      level: "section",
      matches: (s) =>
        s.kind === "section" && !!target.sectionId && s.sectionId === target.sectionId,
    },
    {
      level: "homework",
      matches: (s) =>
        s.kind === "homework" &&
        !!target.homeworkId &&
        s.homeworkId === target.homeworkId,
    },
    {
      level: "course",
      matches: (s) => s.kind === "course" && s.courseId === target.courseId,
    },
    {
      level: "llmConfig",
      matches: (s) =>
        s.kind === "llmConfig" &&
        !!target.llmConfigId &&
        s.llmConfigId === target.llmConfigId,
    },
  ];
}

export function resolveCollections(
  attachments: readonly CollectionAttachmentRecord[],
  target: ResolutionTarget,
): Resolution {
  for (const { level, matches } of matchersFor(target)) {
    const hits = attachments.filter((a) => matches(a.scope));
    if (hits.length === 0) continue;
    return {
      level,
      collectionIds: [...new Set(hits.map((h) => h.collectionId))],
    };
  }
  return { level: "none", collectionIds: [] };
}
