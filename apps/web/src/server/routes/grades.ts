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
import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
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
import { draftGrade } from "../../lib/services/GradingEvaluator";
import {
  loadLLMConfigById,
  resolveApiKey,
  buildProviderClient,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
  type LlmProvider,
} from "../../lib/llm-config";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import { messageTextOf } from "../utils/messageText";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { GradeDraftPayload, GradeListPayload } from "@llteacher/ui/api";
import { BadRequest, Conflict, ExternalServiceError, Forbidden, NotFound } from "../effect/errors";
import { effectHandler, requireCourseAccess, type CourseAccess } from "../effect/http";
import { external, query } from "../effect/services";

const MAX_FEEDBACK_CHARS = 20_000;
/** The scale a draft is asked for when the instructor has not yet chosen
 *  one. Conventional, and only ever a starting value in a form the
 *  instructor edits before saving. */
const DEFAULT_MAX_SCORE = 100;
/** The platform-default LLMoxie model used when no org config resolves. */
const DEFAULT_DRAFT_MODEL_NAME = "gpt-5.3-codex";

/** Instructor-of-course, then the CourseScope for that course. Both refusals
 *  carry the same body, as they always have. */
function instructorContext(c: Context<AppEnv>): Effect.Effect<CourseAccess, Forbidden> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  return authContext && courseId && authContext.isInstructorOf(courseId)
    ? requireCourseAccess(c, "courseId", "Instructor access denied")
    : Effect.fail(new Forbidden({ message: "Instructor access denied" }));
}

function submissionIdParam(c: Context<AppEnv>): string | null {
  const id = c.req.param("submissionId");
  return id && UUID_RE.test(id) ? id : null;
}

const submissionGone = () => new NotFound({ message: "That submission no longer exists." });

/** The cipher keys are process configuration, not request input: a missing
 *  key is a deployment fault, answered as a logged 503 defect. */
const identityCipher = (c: Context<AppEnv>) =>
  Effect.promise(() => loadIdentityCipherKeys(c.env)).pipe(Effect.map((keys) => new IdentityCipher(keys)));

export const listGradesHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorContext(c);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return yield* submissionGone();

  const cipher = yield* identityCipher(c);
  const grades = yield* query(
    "listGradesForSubmission",
    (db) => listGradesForSubmission(db, ctx.scope, submissionId, cipher),
    [SubmissionNotInCourseError],
  ).pipe(Effect.catchTag("SubmissionNotInCourseError", () => Effect.fail(submissionGone())));
  const body: GradeListPayload = { grades };
  return c.json(body);
}));

/** Saves a human grade. Always an insert -- a regrade supersedes rather than
 *  overwrites, so the history a dispute needs survives. */
export const saveGradeHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorContext(c);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return yield* submissionGone();

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<{ score?: unknown; maxScore?: unknown; feedback?: unknown; supersedesGradeId?: unknown }>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });

  const feedback = typeof body.feedback === "string" ? body.feedback : "";
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return yield* new BadRequest({ message: "That feedback is too long." });
  }

  // A score needs a scale, and vice versa -- the same rule
  // grades_score_requires_max_chk enforces, expressed here as a sentence the
  // instructor can act on. Both absent is a supported case: written comments
  // with no number.
  const hasScore = body.score !== null && body.score !== undefined;
  const hasMax = body.maxScore !== null && body.maxScore !== undefined;
  if (hasScore !== hasMax) {
    return yield* new BadRequest({ message: "Enter both a score and the total it is out of, or neither." });
  }

  let score: number | null = null;
  let maxScore: number | null = null;
  if (hasScore) {
    score = typeof body.score === "number" ? body.score : NaN;
    maxScore = typeof body.maxScore === "number" ? body.maxScore : NaN;
    // Finiteness checked explicitly: JSON admits 1e999, which parses to
    // Infinity and slips past a naive range comparison into a double column.
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
      return yield* new BadRequest({ message: "Enter a score and a total greater than zero." });
    }
    if (score < 0 || score > maxScore) {
      return yield* new BadRequest({ message: `Score must be between 0 and ${maxScore}.` });
    }
  }
  if (!hasScore && !feedback.trim()) {
    return yield* new BadRequest({ message: "Enter a score, written feedback, or both." });
  }

  const supersedesGradeId =
    typeof body.supersedesGradeId === "string" && body.supersedesGradeId ? body.supersedesGradeId : null;
  if (supersedesGradeId && !UUID_RE.test(supersedesGradeId)) {
    return yield* new BadRequest({ message: "That draft reference is not valid." });
  }

  const orgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, ctx.courseId));
  if (!orgScope) return yield* new Forbidden({ message: "Instructor access denied" });

  // The grade is attributed to the caller's OWN membership, never to an id
  // from the request: a grader field the client supplies is a grader field
  // the client can forge.
  const graderMembershipId = yield* query(
    "graderMembershipFor",
    (db) => graderMembershipFor(db, ctx.scope, ctx.authContext.session.userId),
  );
  if (!graderMembershipId) return yield* new Forbidden({ message: "Instructor access denied" });

  yield* query(
    "recordHumanGrade",
    (db) => recordHumanGrade(db, ctx.scope, orgScope, {
      submissionId,
      graderMembershipId,
      score,
      maxScore,
      feedback,
      supersedesGradeId,
    }),
    [SubmissionNotInCourseError],
  ).pipe(Effect.catchTag("SubmissionNotInCourseError", () => Effect.fail(submissionGone())));

  yield* query(
    "auditBestEffort",
    (db) => auditBestEffort(db, [orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.GRADE_RECORDED,
      targetType: AUDIT_TARGET_TYPES.SUBMISSION,
      targetId: submissionId,
      // The score is recorded; the feedback is not. Written comments about a
      // named student are the education record itself, and the audit log is
      // for who-did-what, not a second copy of the content.
      requestMetadata: { courseId: ctx.courseId, score, maxScore, fromDraft: supersedesGradeId !== null },
    }),
  ).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("saveGradeHandler", err.cause))));

  const cipher = yield* identityCipher(c);
  // Same refusal as the write above: the submission can only have left the
  // course in the instant between the two statements.
  const grades = yield* query(
    "listGradesForSubmission",
    (db) => listGradesForSubmission(db, ctx.scope, submissionId, cipher),
    [SubmissionNotInCourseError],
  ).pipe(Effect.catchTag("SubmissionNotInCourseError", () => Effect.fail(submissionGone())));
  const responseBody: GradeListPayload = { grades };
  return c.json(responseBody, 201);
}));

/** Builds the model client for one provider. Only UnsupportedLLMProviderError
 *  is a documented refusal; anything else the factory throws is a gateway
 *  fault. */
function providerModel(c: Context<AppEnv>, provider: LlmProvider, apiKey: string, modelName: string) {
  return Effect.try({
    try: () => buildProviderClient(provider, apiKey, { llmoxieBaseUrl: c.env.LLMOXIE_BASE_URL })(modelName),
    catch: (err) =>
      err instanceof UnsupportedLLMProviderError
        ? err
        : new ExternalServiceError({ service: "llm", operation: "buildProviderClient", cause: err }),
  });
}

/** Produces an AI draft. The draft is stored as `graded_by_ai = true`, which
 *  is inert by construction -- it becomes a grade only when an instructor
 *  writes their own row citing it. See repositories/grades.ts. */
export const draftGradeHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorContext(c);
  const submissionId = submissionIdParam(c);
  if (!submissionId) return yield* submissionGone();

  // #365: the up-front `if (!c.env.OPENROUTER_API_KEY) 503` that used to sit
  // here is gone, for the same reason chat.ts dropped its own (#26): WHICH
  // key this draft needs depends on the resolved config's provider, which is
  // not known until that config has been read, below. Gating on OpenRouter's
  // key specifically refused the whole feature on a deployment whose configs
  // are all `llmoxie` -- every organization's default since migration 0035 --
  // and would have sent an LLMOxie model id to openrouter.ai on one that had
  // both keys set.
  const found = yield* query("getSubmissionInCourse", (db) => getSubmissionInCourse(db, ctx.scope, submissionId));
  if (!found) return yield* submissionGone();

  // The section this submission belongs to, its prompt, and its model
  // solution. Joined through the submission's conversation so the whole
  // lookup is course-scoped in one query -- there is no point at which a
  // section id from elsewhere could be substituted.
  const context = yield* query("selectDraftContext", async (db) => {
    const [row] = await db
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
    return row;
  });

  if (!context) {
    // A tutor conversation rather than a section one: there is no prompt and
    // no solution to judge against, so there is nothing to draft from.
    return yield* new Conflict({
      message: "This submission is not attached to a homework section, so it cannot be drafted.",
    });
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
  const rows = yield* query("selectTranscriptTail", async (db) =>
    db
      .select({ role: messages.role, parts: messages.parts })
      .from(messages)
      .where(eq(messages.conversationId, found.conversationId))
      .orderBy(desc(messages.seq))
      .limit(TRANSCRIPT_MESSAGE_LIMIT),
  );
  rows.reverse();

  const transcript = rows.map((r) => ({ role: r.role as string, text: messageTextOf(r.parts) }));
  if (transcript.every((t) => t.text.trim() === "")) {
    return yield* new Conflict({ message: "This conversation has no content to assess." });
  }

  /* #421: the course's own llm_config_id comes back with the scope, in the
     same round-trip, and is passed into the walk -- otherwise this path skips
     the course tier and can draft a grade on a different model than the one
     that produced the conversation being graded. */
  const courseScope = yield* query(
    "getOrgScopeAndLlmConfigForCourse",
    (db) => getOrgScopeAndLlmConfigForCourse(db, ctx.courseId),
  );
  const orgScope = courseScope?.orgScope ?? null;
  const config = orgScope
    ? yield* query("resolveLlmConfig", (db) => resolveLlmConfig(db, orgScope, {
        sectionId: context.sectionId,
        courseLlmConfigId: courseScope?.courseLlmConfigId ?? null,
      }))
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
    orgScope && config
      ? yield* query(
          "loadLLMConfigById",
          (db) => loadLLMConfigById(db, orgScope, config.id, { activeOnly: false }),
        )
      : null;

  const gatewayNotConfigured = (err: unknown) => {
    logServerError("draftGradeHandler", err);
    return c.json({ error: "The model gateway is not configured. Contact an administrator." }, 503);
  };
  /* #425: same reasoning as testLlmConfigHandler -- resolveApiKey reads
     organization_credentials, so a transient DB failure is reachable here
     and should not escape as an unhandled 500 on an instructor-initiated
     action. */
  const gatewayUnreachable = (err: unknown) => {
    logServerError("draftGradeHandler", err);
    return c.json({ error: "The model gateway could not be reached. Try again shortly." }, 503);
  };
  const model = yield* Effect.gen(function* () {
    if (resolvedConfig && orgScope) {
      const apiKey = yield* query(
        "resolveApiKey",
        (db) => resolveApiKey(c.env, db, orgScope, resolvedConfig),
        [LLMCredentialMissingError],
      );
      return yield* providerModel(c, resolvedConfig.provider, apiKey, resolvedConfig.modelName);
    }
    if (!c.env.LLMOXIE_API_KEY) {
      return yield* Effect.fail(new LLMCredentialMissingError("LLMOXIE_API_KEY is not configured"));
    }
    return yield* providerModel(c, "llmoxie", c.env.LLMOXIE_API_KEY, DEFAULT_DRAFT_MODEL_NAME);
  }).pipe(Effect.catchTags({
    // These 503s carry their own sentences, not the generic one: an
    // instructor pressed a button and the next step is an administrator.
    LLMCredentialMissingError: (err) => Effect.succeed(gatewayNotConfigured(err)),
    UnsupportedLLMProviderError: (err) => Effect.succeed(gatewayNotConfigured(err)),
    DatabaseError: (err) => Effect.succeed(gatewayUnreachable(err.cause)),
    ExternalServiceError: (err) => Effect.succeed(gatewayUnreachable(err.cause)),
  }));
  if (model instanceof Response) return model;

  // draftGrade never throws for a model-side failure (it answers null);
  // anything it does throw is an LLM-gateway fault, answered 503.
  const draft = yield* external("llm", "draftGrade", () => draftGrade({
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
  }));

  if (!draft) {
    // An ordinary outcome for an optional assistant, not a server fault: the
    // instructor grades directly, which they could always do.
    return c.json({ error: "Could not draft a grade for this submission. Grade it directly." }, 502);
  }

  if (!orgScope) return yield* new Forbidden({ message: "Instructor access denied" });
  const draftGradeId = yield* query(
    "recordAiDraft",
    (db) => recordAiDraft(db, ctx.scope, orgScope, {
      submissionId,
      score: draft.score,
      maxScore: draft.maxScore,
      rationale: draft.rationale,
      modelName: draft.modelName,
    }),
    [SubmissionNotInCourseError],
  ).pipe(Effect.catchTag("SubmissionNotInCourseError", () => Effect.fail(submissionGone())));

  yield* query(
    "auditBestEffort",
    (db) => auditBestEffort(db, [orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action: AUDIT_ACTIONS.GRADE_DRAFTED,
      targetType: AUDIT_TARGET_TYPES.SUBMISSION,
      targetId: submissionId,
      requestMetadata: { courseId: ctx.courseId, modelName: draft.modelName },
    }),
  ).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("draftGradeHandler", err.cause))));

  const body: GradeDraftPayload = {
    draftGradeId,
    score: draft.score,
    maxScore: draft.maxScore,
    rationale: draft.rationale,
    modelName: draft.modelName,
  };
  return c.json(body, 201);
}));
