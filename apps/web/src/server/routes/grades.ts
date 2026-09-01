/* --------------------------------------------------------------------------
   Grading routes (#75).

   Instructor-only, deliberately, even though #172 made submission READS
   grader-tier. A TA may read a student's work; a grade is a record the
   student may dispute and the institution may be asked to defend, so it is
   attributed to someone with authority over the course. The repository's
   own pre-existing grader check took the same position, and having the route
   disagree with the repository would be worse than either rule alone.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { UUID_RE } from "../utils/uuid";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import {
  conversations,
  messages,
  sectionSolutions,
  sections,
  submissions,
} from "../../db/schema";
import {
  SubmissionNotInCourseError,
  getSubmissionInCourse,
  graderMembershipFor,
  listGradesForSubmission,
  recordAiDraft,
  recordHumanGrade,
} from "../repositories/grades";
import { getOrgScopeForCourse, getOrgScopeAndLlmConfigForCourse } from "../repositories/organizations";
import { resolveLlmConfig } from "../repositories/llmConfigs";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { draftGrade } from "../../lib/services/GradingEvaluator";
import {
  loadLLMConfigById,
  resolveApiKey,
  buildProviderClient,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
} from "../../lib/llm-config";
import { getOpenRouter } from "../../lib/ai";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import { messageTextOf } from "../utils/messageText";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CourseScope } from "../repositories/scope";
import type { GradeDraftPayload, GradeListPayload } from "@llteacher/ui/api";

const MAX_FEEDBACK_CHARS = 20_000;
/** The scale a draft is asked for when the instructor has not yet chosen
 *  one. Conventional, and only ever a starting value in a form the
 *  instructor edits before saving. */
const DEFAULT_MAX_SCORE = 100;
/** #365: the model a draft falls back to when no `llm_configs` row resolves
 *  for the course's org at all. Named once, because it is now consulted in
 *  two places that must not disagree -- the client built for it, and the
 *  `modelName` recorded on the draft. It IS an OpenRouter model, which is why
 *  that one branch legitimately reaches for OPENROUTER_API_KEY by name. */
const DEFAULT_DRAFT_MODEL_NAME = "google/gemma-4-31b-it:free";

async function instructorContext(
  c: Context<AppEnv>,
): Promise<{ scope: CourseScope; courseId: string; authContext: AuthContext } | null> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return null;
  const scope = courseScopeFromAuthContext(authContext, courseId);
  return scope ? { scope, courseId, authContext } : null;
}

function submissionIdParam(c: Context<AppEnv>): string | null {
  const id = c.req.param("submissionId");
  return id && UUID_RE.test(id) ? id : null;
}

export async function listGradesHandler(c: Context<AppEnv>) {
  const ctx = await instructorContext(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return c.json({ error: "That submission no longer exists." }, 404);

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  try {
    const grades = await listGradesForSubmission(db, ctx.scope, submissionId, cipher);
    const body: GradeListPayload = { grades };
    return c.json(body);
  } catch (err) {
    if (err instanceof SubmissionNotInCourseError) {
      return c.json({ error: "That submission no longer exists." }, 404);
    }
    throw err;
  }
}

/** Saves a human grade. Always an insert -- a regrade supersedes rather than
 *  overwrites, so the history a dispute needs survives. */
export async function saveGradeHandler(c: Context<AppEnv>) {
  const ctx = await instructorContext(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return c.json({ error: "That submission no longer exists." }, 404);

  let body: { score?: unknown; maxScore?: unknown; feedback?: unknown; supersedesGradeId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const feedback = typeof body.feedback === "string" ? body.feedback : "";
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return c.json({ error: "That feedback is too long." }, 400);
  }

  // A score needs a scale, and vice versa -- the same rule
  // grades_score_requires_max_chk enforces, expressed here as a sentence the
  // instructor can act on. Both absent is a supported case: written comments
  // with no number.
  const hasScore = body.score !== null && body.score !== undefined;
  const hasMax = body.maxScore !== null && body.maxScore !== undefined;
  if (hasScore !== hasMax) {
    return c.json({ error: "Enter both a score and the total it is out of, or neither." }, 400);
  }

  let score: number | null = null;
  let maxScore: number | null = null;
  if (hasScore) {
    score = typeof body.score === "number" ? body.score : NaN;
    maxScore = typeof body.maxScore === "number" ? body.maxScore : NaN;
    // Finiteness checked explicitly: JSON admits 1e999, which parses to
    // Infinity and slips past a naive range comparison into a double column.
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
      return c.json({ error: "Enter a score and a total greater than zero." }, 400);
    }
    if (score < 0 || score > maxScore) {
      return c.json({ error: `Score must be between 0 and ${maxScore}.` }, 400);
    }
  }
  if (!hasScore && !feedback.trim()) {
    return c.json({ error: "Enter a score, written feedback, or both." }, 400);
  }

  const supersedesGradeId =
    typeof body.supersedesGradeId === "string" && body.supersedesGradeId ? body.supersedesGradeId : null;
  if (supersedesGradeId && !UUID_RE.test(supersedesGradeId)) {
    return c.json({ error: "That draft reference is not valid." }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const orgScope = await getOrgScopeForCourse(db, ctx.courseId);
  if (!orgScope) return c.json({ error: "Instructor access denied" }, 403);

  // The grade is attributed to the caller's OWN membership, never to an id
  // from the request: a grader field the client supplies is a grader field
  // the client can forge.
  const graderMembershipId = await graderMembershipFor(
    db,
    ctx.scope,
    ctx.authContext.session.userId,
  );
  if (!graderMembershipId) return c.json({ error: "Instructor access denied" }, 403);

  try {
    await recordHumanGrade(db, ctx.scope, orgScope, {
      submissionId,
      graderMembershipId,
      score,
      maxScore,
      feedback,
      supersedesGradeId,
    });
  } catch (err) {
    if (err instanceof SubmissionNotInCourseError) {
      return c.json({ error: "That submission no longer exists." }, 404);
    }
    throw err;
  }

  try {
    await auditBestEffort(db, [orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.GRADE_RECORDED,
      targetType: AUDIT_TARGET_TYPES.SUBMISSION,
      targetId: submissionId,
      // The score is recorded; the feedback is not. Written comments about a
      // named student are the education record itself, and the audit log is
      // for who-did-what, not a second copy of the content.
      requestMetadata: { courseId: ctx.courseId, score, maxScore, fromDraft: supersedesGradeId !== null },
    });
  } catch (err) {
    logServerError("saveGradeHandler", err);
  }

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const grades = await listGradesForSubmission(db, ctx.scope, submissionId, cipher);
  const responseBody: GradeListPayload = { grades };
  return c.json(responseBody, 201);
}

/** Produces an AI draft. The draft is stored as `graded_by_ai = true`, which
 *  is inert by construction -- it becomes a grade only when an instructor
 *  writes their own row citing it. See repositories/grades.ts. */
export async function draftGradeHandler(c: Context<AppEnv>) {
  const ctx = await instructorContext(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return c.json({ error: "That submission no longer exists." }, 404);

  // #365: the up-front `if (!c.env.OPENROUTER_API_KEY) 503` that used to sit
  // here is gone, for the same reason chat.ts dropped its own (#26): WHICH
  // key this draft needs depends on the resolved config's provider, which is
  // not known until that config has been read, below. Gating on OpenRouter's
  // key specifically refused the whole feature on a deployment whose configs
  // are all `llmoxie` -- every organization's default since migration 0035 --
  // and would have sent an LLMOxie model id to openrouter.ai on one that had
  // both keys set.
  const db = makeDb(c.env.DATABASE_URL);
  const found = await getSubmissionInCourse(db, ctx.scope, submissionId);
  if (!found) return c.json({ error: "That submission no longer exists." }, 404);

  // The section this submission belongs to, its prompt, and its model
  // solution. Joined through the submission's conversation so the whole
  // lookup is course-scoped in one query -- there is no point at which a
  // section id from elsewhere could be substituted.
  const [context] = await db
    .select({
      sectionContent: sections.content,
      sectionId: sections.id,
      solution: sectionSolutions.content,
    })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .leftJoin(sectionSolutions, eq(sectionSolutions.sectionId, sections.id))
    .where(and(eq(submissions.id, submissionId), eq(conversations.courseId, ctx.scope)));

  if (!context) {
    // A tutor conversation rather than a section one: there is no prompt and
    // no solution to judge against, so there is nothing to draft from.
    return c.json(
      { error: "This submission is not attached to a homework section, so it cannot be drafted." },
      409,
    );
  }

  /* #362: the TAIL, bounded, rather than every message in the conversation.
     `draftGrade` keeps only the last ~24 000 characters -- understanding
     lands at the END of a tutoring conversation -- so reading the whole
     thing loads rows into the Worker only to throw most of them away.
     Ordered descending with a limit, then reversed back into reading order.

     240 is that character budget divided by a conservative 100 characters
     per message. A conversation whose messages are shorter simply sends
     fewer characters than the budget allows, which costs nothing. */
  const TRANSCRIPT_MESSAGE_LIMIT = 240;
  const rows = await db
    .select({ role: messages.role, parts: messages.parts })
    .from(messages)
    .where(eq(messages.conversationId, found.conversationId))
    .orderBy(desc(messages.seq))
    .limit(TRANSCRIPT_MESSAGE_LIMIT);
  rows.reverse();

  const transcript = rows.map((r) => ({ role: r.role as string, text: messageTextOf(r.parts) }));
  if (transcript.every((t) => t.text.trim() === "")) {
    return c.json({ error: "This conversation has no content to assess." }, 409);
  }

  /* #421: the course's own llm_config_id comes back with the scope, in the
     same round-trip, and is passed into the walk -- otherwise this path skips
     the course tier and can draft a grade on a different model than the one
     that produced the conversation being graded. */
  const courseScope = await getOrgScopeAndLlmConfigForCourse(db, ctx.courseId);
  const orgScope = courseScope?.orgScope ?? null;
  const config = orgScope
    ? await resolveLlmConfig(db, orgScope, {
        sectionId: context.sectionId,
        courseLlmConfigId: courseScope?.courseLlmConfigId ?? null,
      })
    : null;

  // #365: build the client from the resolved config's OWN provider and
  // credential, the same buildProviderClient + resolveApiKey pair chat.ts and
  // the config-test button use. `resolveLlmConfig` returns the console's
  // LlmConfigRecord, which deliberately carries no credentialId, so the row
  // is re-read through `loadLLMConfigById` for the credential-bearing shape
  // -- one extra read on an explicitly instructor-initiated action, and the
  // alternative was widening the admin wire contract for a field only the
  // server needs. `activeOnly: false` because resolveLlmConfig has already
  // applied its own is_active rule at every tier it walked.
  const resolvedConfig =
    orgScope && config ? await loadLLMConfigById(db, orgScope, config.id, { activeOnly: false }) : null;

  let model;
  try {
    if (resolvedConfig && orgScope) {
      const apiKey = await resolveApiKey(c.env, db, orgScope, resolvedConfig);
      model = buildProviderClient(resolvedConfig.provider, apiKey, {
        llmoxieBaseUrl: c.env.LLMOXIE_BASE_URL,
      })(resolvedConfig.modelName);
    } else {
      // No org scope, or no config resolvable for it. Unchanged from before:
      // the historic hardcoded default, which IS an openrouter model and so
      // legitimately needs an OpenRouter key -- the one case where naming
      // that binding directly is correct rather than an assumption.
      if (!c.env.OPENROUTER_API_KEY) {
        logServerError("draftGradeHandler", new Error("OPENROUTER_API_KEY is not configured"));
        return c.json({ error: "The model gateway is not configured. Contact an administrator." }, 503);
      }
      model = getOpenRouter(c.env.OPENROUTER_API_KEY)(DEFAULT_DRAFT_MODEL_NAME);
    }
  } catch (err) {
    if (err instanceof LLMCredentialMissingError || err instanceof UnsupportedLLMProviderError) {
      logServerError("draftGradeHandler", err);
      return c.json({ error: "The model gateway is not configured. Contact an administrator." }, 503);
    }
    /* #425: same reasoning as testLlmConfigHandler -- resolveApiKey reads
       organization_credentials, so a transient DB failure is reachable here
       and should not escape as an unhandled 500 on an instructor-initiated
       action. */
    logServerError("draftGradeHandler", err);
    return c.json({ error: "The model gateway could not be reached. Try again shortly." }, 503);
  }

  const draft = await draftGrade({
    sectionContent: context.sectionContent,
    solutionContent: context.solution ?? null,
    transcript,
    maxScore: DEFAULT_MAX_SCORE,
    // The course's own configured model, so a draft is produced by the same
    // model the instructor chose for the course rather than by whatever this
    // route happened to hardcode. #365: `model` is the client built for that
    // config's own PROVIDER just above -- the model name alone was never
    // enough, since this used to be handed to getOpenRouter regardless.
    modelName: resolvedConfig?.modelName ?? DEFAULT_DRAFT_MODEL_NAME,
    model,
  });

  if (!draft) {
    // An ordinary outcome for an optional assistant, not a server fault: the
    // instructor grades directly, which they could always do.
    return c.json({ error: "Could not draft a grade for this submission. Grade it directly." }, 502);
  }

  if (!orgScope) return c.json({ error: "Instructor access denied" }, 403);
  const draftGradeId = await recordAiDraft(db, ctx.scope, orgScope, {
    submissionId,
    score: draft.score,
    maxScore: draft.maxScore,
    rationale: draft.rationale,
    modelName: draft.modelName,
  });

  try {
    await auditBestEffort(db, [orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.GRADE_DRAFTED,
      targetType: AUDIT_TARGET_TYPES.SUBMISSION,
      targetId: submissionId,
      requestMetadata: { courseId: ctx.courseId, modelName: draft.modelName },
    });
  } catch (err) {
    logServerError("draftGradeHandler", err);
  }

  const body: GradeDraftPayload = {
    draftGradeId,
    score: draft.score,
    maxScore: draft.maxScore,
    rationale: draft.rationale,
    modelName: draft.modelName,
  };
  return c.json(body, 201);
}


