/* --------------------------------------------------------------------------
   #75: the grading routes.

   repositories/grades.test.ts owns the data invariants against a real
   Postgres. This file owns the request contract -- who is admitted, which
   bodies are refused, and the one thing a route can get wrong that the
   repository cannot: attributing a grade to a grader the CLIENT named.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { draftGradeHandler, listGradesHandler, saveGradeHandler } from "./grades";
import { SubmissionNotInCourseError } from "../repositories/grades";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { LLMCredentialMissingError } from "../../lib/llm-config";

const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "sk-test" } as Env;
const SUBMISSION_ID = "11111111-2222-4333-8444-555555555555";
const GRADE_ID = "11111111-2222-4333-8444-555555555556";

const listGradesMock = vi.fn();
const recordHumanGradeMock = vi.fn();
const graderMembershipForMock = vi.fn();
const getSubmissionInCourseMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
/** #421: the course-level llm_config_id the resolver should see. Null in
 *  every existing test, which is what keeps their homework -> org-default
 *  expectations unchanged. */
const getCourseLlmConfigIdMock = vi.fn<() => string | null>(() => null);
const auditBestEffortMock = vi.fn();

vi.mock("../repositories/grades", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/grades")>()),
  listGradesForSubmission: (...a: unknown[]) => listGradesMock(...a),
  recordHumanGrade: (...a: unknown[]) => recordHumanGradeMock(...a),
  recordAiDraft: async () => GRADE_ID,
  graderMembershipFor: (...a: unknown[]) => graderMembershipForMock(...a),
  getSubmissionInCourse: (...a: unknown[]) => getSubmissionInCourseMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
  /* #421: the draft-grade path resolves through the COURSE tier now, so it
     reads the scope and the course's own llm_config_id in one round-trip.
     Derived from the same mock, so a test that sets one org scope does not
     have to set two. `courseLlmConfigId` defaults to null -- the course-level
     override is opted into per-test via getCourseLlmConfigIdMock. */
  getOrgScopeAndLlmConfigForCourse: async (...a: unknown[]) => {
    const orgScope = await getOrgScopeForCourseMock(...a);
    return orgScope ? { orgScope, courseLlmConfigId: getCourseLlmConfigIdMock() } : null;
  },
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
/* #365: a chainable Drizzle stub, replacing a hand-shaped one that modelled
   exactly `select().from().innerJoin().leftJoin().where()`. draftGradeHandler
   issues TWO joined queries (the section/solution context, then the message
   tail with orderBy/limit), and the old stub had no second `innerJoin` and no
   `orderBy`, so the handler threw a TypeError there. That went unnoticed only
   because the OPENROUTER_API_KEY gate used to return before either query ran
   -- which meant the draft route's model-selection path had no route-level
   coverage at all. Every terminal await now takes the next queued result, so
   the two queries can return their own shapes. */
const dbResults: unknown[][] = [];
function chainableDb(): unknown {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
    node[method] = () => node;
  }
  node.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve, reject);
  return node;
}
vi.mock("../../db/client", () => ({ makeDb: () => chainableDb() }));

const resolveLlmConfigMock = vi.fn();
const loadLLMConfigByIdMock = vi.fn();
const resolveApiKeyMock = vi.fn();
const buildProviderClientMock = vi.fn();
const draftGradeMock = vi.fn();
vi.mock("../repositories/llmConfigs", () => ({
  resolveLlmConfig: (...a: unknown[]) => resolveLlmConfigMock(...a),
}));
vi.mock("../../lib/llm-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm-config")>()),
  loadLLMConfigById: (...a: unknown[]) => loadLLMConfigByIdMock(...a),
  resolveApiKey: (...a: unknown[]) => resolveApiKeyMock(...a),
  buildProviderClient: (...a: unknown[]) => buildProviderClientMock(...a),
}));
vi.mock("../../lib/services/GradingEvaluator", () => ({
  draftGrade: (...a: unknown[]) => draftGradeMock(...a),
}));
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({ IdentityCipher: class {} }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/submissions/:submissionId/grades";
  app.get(base, (c) => listGradesHandler(c));
  app.post(base, (c) => saveGradeHandler(c));
  app.post(`${base}/draft`, (c) => draftGradeHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const url = (suffix = "") =>
  `/api/courses/course-a/submissions/${SUBMISSION_ID}/grades${suffix}`;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  listGradesMock.mockReset().mockResolvedValue([]);
  recordHumanGradeMock.mockReset().mockResolvedValue(GRADE_ID);
  graderMembershipForMock.mockReset().mockResolvedValue("membership-1");
  getSubmissionInCourseMock
    .mockReset()
    .mockResolvedValue({ submissionId: SUBMISSION_ID, conversationId: "conv-1", studentUserId: "u-student" });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  getCourseLlmConfigIdMock.mockReset().mockReturnValue(null);
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});

  // #365: the draft path's two queries, in the order the handler issues them
  // -- the section/solution context, then the message tail.
  dbResults.length = 0;
  dbResults.push(
    [{ sectionContent: "Explain a p-value.", sectionId: "sec-1", solution: null }],
    [{ role: "user", parts: [{ type: "text", text: "I think it means..." }] }],
  );
  // An org whose default config is llmoxie -- what migration 0035 makes every
  // organization's, and the exact case the old hardcoded OpenRouter client
  // got wrong.
  resolveLlmConfigMock.mockReset().mockResolvedValue({ id: "cfg-1", modelName: "gpt-5.3-codex" });
  loadLLMConfigByIdMock.mockReset().mockResolvedValue({
    id: "cfg-1",
    provider: "llmoxie",
    modelName: "gpt-5.3-codex",
    temperature: 0.7,
    maxCompletionTokens: 1000,
    credentialId: "cred-1",
    fallbackLlmConfigId: null,
    basePrompt: "",
    pricePerMillionInputTokens: null,
    pricePerMillionOutputTokens: null,
    markCompleteInstruction: null,
  });
  resolveApiKeyMock.mockReset().mockResolvedValue("sk-llmoxie");
  buildProviderClientMock
    .mockReset()
    .mockImplementation((provider: string, apiKey: string) => (model: string) => ({
      provider,
      apiKey,
      model,
    }));
  draftGradeMock
    .mockReset()
    .mockResolvedValue({ score: 80, maxScore: 100, rationale: "ok", modelName: "gpt-5.3-codex" });
});

describe("grading authorization (#75)", () => {
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET grades", undefined, url()],
    ["POST grade", json({ score: 80, maxScore: 100, feedback: "ok" }), url()],
    ["POST draft", json({}), url("/draft")],
  ];

  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      // A TA may READ student work (#172) but a grade is an education record
      // the student may dispute -- a different authority.
      expect((await buildApp(taOfA()).request(path, init, TEST_ENV)).status).toBe(403);
    });
    it(`denies an instructor of another course on ${label}`, async () => {
      const other = fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-z", role: "instructor" })],
      });
      expect((await buildApp(other).request(path, init, TEST_ENV)).status).toBe(403);
    });
  }
});

describe("POST grade (#75)", () => {
  const post = (body: unknown) => buildApp(instructorOfA()).request(url(), json(body), TEST_ENV);

  it("attributes the grade to the CALLER's membership, never one from the body", async () => {
    // A grader field the client supplies is a grader field the client can
    // forge -- and a grade names who stands behind it.
    await post({ score: 80, maxScore: 100, feedback: "ok", graderMembershipId: "someone-else" });
    expect(recordHumanGradeMock.mock.calls[0]![3]).toMatchObject({
      graderMembershipId: "membership-1",
    });
  });

  it("refuses to grade when the caller's own membership may not grade", async () => {
    graderMembershipForMock.mockResolvedValue(null);
    expect((await post({ score: 80, maxScore: 100, feedback: "ok" })).status).toBe(403);
    expect(recordHumanGradeMock).not.toHaveBeenCalled();
  });

  it("requires a score and its scale together, or neither", async () => {
    // "7" with no denominator is unreadable a term later; a denominator with
    // no score is a form half-filled.
    expect((await post({ score: 80, feedback: "ok" })).status).toBe(400);
    expect((await post({ maxScore: 100, feedback: "ok" })).status).toBe(400);
    expect((await post({ feedback: "Written comments only." })).status).toBe(201);
  });

  it("rejects a score outside its scale, and a non-finite one", async () => {
    expect((await post({ score: 101, maxScore: 100, feedback: "x" })).status).toBe(400);
    expect((await post({ score: -1, maxScore: 100, feedback: "x" })).status).toBe(400);
    expect((await post({ score: 1, maxScore: 0, feedback: "x" })).status).toBe(400);
    const res = await buildApp(instructorOfA()).request(
      url(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // JSON admits 1e999, which parses to Infinity and slips past a naive
        // range comparison into a double column.
        body: '{"score":1e999,"maxScore":100,"feedback":"x"}',
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(recordHumanGradeMock).not.toHaveBeenCalled();
  });

  it("rejects an entirely empty grade", async () => {
    expect((await post({ feedback: "   " })).status).toBe(400);
  });

  it("404s a submission from another course", async () => {
    recordHumanGradeMock.mockRejectedValue(new SubmissionNotInCourseError());
    expect((await post({ score: 80, maxScore: 100, feedback: "x" })).status).toBe(404);
  });

  it("audits the score but never the written feedback", async () => {
    await post({ score: 80, maxScore: 100, feedback: "Ada misread the null hypothesis." });
    const metadata = auditBestEffortMock.mock.calls[0]![2].requestMetadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ score: 80, maxScore: 100 });
    // Written comments about a named student are the education record
    // itself; the audit log is for who-did-what, not a second copy.
    expect(JSON.stringify(metadata)).not.toContain("null hypothesis");
  });

  it("records that a grade came from a draft", async () => {
    await post({ score: 82, maxScore: 100, feedback: "Edited.", supersedesGradeId: GRADE_ID });
    expect(recordHumanGradeMock.mock.calls[0]![3]).toMatchObject({ supersedesGradeId: GRADE_ID });
    expect(auditBestEffortMock.mock.calls[0]![2].requestMetadata).toMatchObject({ fromDraft: true });
  });

  it("rejects a malformed draft reference", async () => {
    expect(
      (await post({ score: 1, maxScore: 10, feedback: "x", supersedesGradeId: "nope" })).status,
    ).toBe(400);
  });
});

describe("GET grades (#75)", () => {
  it("404s a malformed submission id without reaching the database", async () => {
    const res = await buildApp(instructorOfA()).request(
      "/api/courses/course-a/submissions/not-a-uuid/grades",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(listGradesMock).not.toHaveBeenCalled();
  });

  it("404s a submission from another course", async () => {
    listGradesMock.mockRejectedValue(new SubmissionNotInCourseError());
    expect((await buildApp(instructorOfA()).request(url(), undefined, TEST_ENV)).status).toBe(404);
  });
});

describe("POST draft (#75)", () => {
  const draft = (env: Env = TEST_ENV) => buildApp(instructorOfA()).request(url("/draft"), json({}), env);

  /** #365: the draft used to be produced by `getOpenRouter(OPENROUTER_API_KEY)`
   *  whatever the resolved config said, so an org on the post-0035 default
   *  (llmoxie/gpt-5.3-codex) had that model id sent to openrouter.ai under an
   *  OpenRouter key. The route now resolves provider and credential from the
   *  config itself, the same way chat.ts does. */
  it("drafts through the resolved config's OWN provider and credential", async () => {
    const res = await draft();
    expect(res.status).toBe(201);

    expect(resolveApiKeyMock.mock.calls[0]![3]).toMatchObject({ credentialId: "cred-1" });
    expect(buildProviderClientMock.mock.calls[0]![0]).toBe("llmoxie");
    expect(buildProviderClientMock.mock.calls[0]![1]).toBe("sk-llmoxie");
    expect(draftGradeMock.mock.calls[0]![0]).toMatchObject({
      modelName: "gpt-5.3-codex",
      model: { provider: "llmoxie", apiKey: "sk-llmoxie", model: "gpt-5.3-codex" },
    });
  });

  it("does not need an OpenRouter key when the config is not an OpenRouter one", async () => {
    // The old up-front gate refused the whole feature on a deployment whose
    // configs are all llmoxie, which after migration 0035 is every one of
    // them by default.
    const res = await draft({ DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(201);
    expect(draftGradeMock).toHaveBeenCalled();
  });

  it("503s with an actionable sentence when the config's own key is unreachable", async () => {
    resolveApiKeyMock.mockRejectedValue(
      new LLMCredentialMissingError("fallback env var LLMOXIE_API_KEY is not set"),
    );
    const res = await draft();
    expect(res.status).toBe(503);
    expect(draftGradeMock).not.toHaveBeenCalled();
  });

  it("still 503s on a missing OpenRouter key for the no-config default, which IS an OpenRouter model", async () => {
    resolveLlmConfigMock.mockResolvedValue(null);
    const res = await draft({ DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(503);
    expect(draftGradeMock).not.toHaveBeenCalled();
  });

  it("404s a submission that is not in this course", async () => {
    getSubmissionInCourseMock.mockResolvedValue(null);
    expect((await buildApp(instructorOfA()).request(url("/draft"), json({}), TEST_ENV)).status).toBe(
      404,
    );
  });
});
