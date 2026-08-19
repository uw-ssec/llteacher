-- PR #317 review, non-blocking #346 (requirement 2).
--
-- resolvePromptTemplate's write-back (chat.ts) only pins a conversation's
-- promptTemplateId when the section -> homework -> course -> org walk
-- actually found a real prompt_templates row somewhere. No migration has
-- ever inserted a prompt_templates row for every org -- the only writer is
-- scripts/seed.ts, and `db:seed` is not part of `deploy` -- so an org with
-- no seeded template resolves to DEFAULT_SYSTEM_PROMPT (resolved.id ===
-- null) forever, and the full 4-level walk (a sections read plus four scope
-- predicates, every one returning nothing) re-runs on EVERY turn instead of
-- pinning once, violating prompts.ts's own stated invariant ("resolved ONCE
-- per conversation ... never re-resolved per-message").
--
-- Backfills a neutral, org-scoped row -- DEFAULT_SYSTEM_PROMPT's own text
-- verbatim, so resolved *content* is unchanged by this migration; it only
-- gives that content a real row for the write-back to pin conversations to
-- -- for every organization that has no ACTIVE prompt_templates row at ANY
-- scope (org, or a course/homework/section belonging to it) today. An org
-- that already has some active template somewhere in the walk is left
-- alone: resolution already stops before reaching DEFAULT_SYSTEM_PROMPT for
-- it, so the "walk repeats forever" problem this migration fixes doesn't
-- apply.
INSERT INTO prompt_templates (scope_organization_id, content, version, is_active)
SELECT o.id,
  E'You are an AI tutor. Guide students through problems using the Socratic method: ask leading questions, build intuition step by step, never just dump the answer.\n\nBe warm, curious, and patient. Prefer questions over assertions.',
  1,
  true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM prompt_templates pt
  WHERE pt.is_active = true
    AND (
      pt.scope_organization_id = o.id
      OR pt.scope_course_id IN (
        SELECT c.id FROM courses c WHERE c.organization_id = o.id
      )
      OR pt.scope_homework_id IN (
        SELECT h.id FROM homeworks h JOIN courses c ON h.course_id = c.id WHERE c.organization_id = o.id
      )
      OR pt.scope_section_id IN (
        SELECT s.id FROM sections s
        JOIN homeworks h ON s.homework_id = h.id
        JOIN courses c ON h.course_id = c.id
        WHERE c.organization_id = o.id
      )
    )
);
