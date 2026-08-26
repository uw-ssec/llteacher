import { Hono } from "hono";
import { helloHandler } from "./routes/hello";
import { chatHandler } from "./routes/chat";
import { loginHandler, callbackHandler, logoutHandler } from "./routes/auth";
import { getProfileHandler, patchProfileHandler } from "./routes/profile";
import {
  listHomeworksHandler,
  createHomeworkHandler,
  getHomeworkDetailHandler,
  updateHomeworkHandler,
  deleteHomeworkHandler,
  publishHomeworkHandler,
  updateHomeworkHideHandler,
} from "./routes/homeworks";
import { workosWebhookHandler } from "./routes/webhooksWorkos";
import {
  listConversationsHandler,
  createConversationHandler,
  updateConversationHandler,
  deleteConversationHandler,
  listConversationMessagesHandler,
} from "./routes/conversations";
import { studentHomeworksHandler } from "./routes/studentHomeworks";
import { submitSectionHandler, getHomeworkSubmissionsHandler } from "./routes/submissions";
import {
  startSectionConversationHandler,
  getActiveSectionConversationHandler,
  getSectionConversationHandler,
  restartSectionConversationHandler,
} from "./routes/sectionConversations";
import { submitSectionAnswerHandler, getSectionAnswerHandler } from "./routes/sectionAnswers";
import { getSectionHintsHandler } from "./routes/hints";
import {
  listInstructorTranscriptsHandler,
  getInstructorTranscriptHandler,
} from "./routes/instructor/transcripts";
import { submitWidgetResponseHandler } from "./routes/progressWidgets";
import {
  addCourseTasHandler,
  listCourseTasHandler,
  removeCourseTaHandler,
  updateTaCapabilitiesHandler,
} from "./routes/courseMemberships";
import {
  cloneLlmConfigHandler,
  createLlmConfigHandler,
  deactivateLlmConfigHandler,
  getLlmConfigHandler,
  listLlmConfigsHandler,
  testLlmConfigHandler,
  updateLlmConfigHandler,
} from "./routes/llmConfigs";
import {
  addRosterMemberHandler,
  importRosterHandler,
  listRosterHandler,
  removeRosterMemberHandler,
} from "./routes/roster";
import { draftGradeHandler, listGradesHandler, saveGradeHandler } from "./routes/grades";
import { createExportHandler } from "./routes/exports";
import {
  getCoursePromptTemplateHandler,
  putCoursePromptTemplateHandler,
  deleteCoursePromptTemplateHandler,
} from "./routes/promptTemplates";
import { listLlmModelsHandler } from "./routes/llmModels";
import { authMiddleware } from "./middleware/auth";
import { rolesMiddleware } from "./middleware/roles";
import { requireCourseMember, requireGraderOf, requireInstructorOf, requireRole } from "./utils/guards";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "./utils/errors";
import { TenancyMismatchError, IdempotencyKeyConflictError, PromptTemplateConflictError } from "./repositories/errors";
import type { AppEnv } from "./context";

const app = new Hono<AppEnv>();

// Catches anything thrown by middleware/handlers that isn't already handled
// locally -- e.g. a DB connection failure in rolesMiddleware or a profile
// route. Logs the real error server-side; the client only ever sees the
// generic message, never DB connection strings or driver internals.
//
// #141: a TenancyMismatchError (repositories/errors.ts) is the one
// exception to that -- createConversation/appendMessage
// (repositories/conversations.ts) throw it for an expected,
// non-infra condition (a caller-supplied id that doesn't belong to the
// scope it's used under), so it's mapped to an honest 404 here instead,
// without logging it as a server-side failure. This is the single
// route-layer mapping point for that error class -- see ARCHITECTURE.md's
// "Tenancy Mismatch Errors" section. Checked before the generic case so it
// takes precedence.
app.onError((err, c) => {
  if (err instanceof TenancyMismatchError) {
    return c.json({ error: "Not found" }, 404);
  }
  // #266: appendMessage throws this when a client reuses a clientMessageId
  // for different content than the row already stored under it -- the
  // request is well-formed and the caller is who they say they are, the id
  // just collides. 409, not a silent 200 that discards the new message.
  //
  // Carries the same `code` chatHandler's own local catch (routes/chat.ts)
  // returns, so the two paths are indistinguishable to readErrorMessage
  // (packages/ui) -- a body with no `code` at all falls into its `default`
  // branch, which is both retryable and worded as a model failure ("The
  // tutor didn't finish answering"), neither of which is true here.
  if (err instanceof IdempotencyKeyConflictError) {
    return c.json({ error: err.message, code: "duplicate_message" }, 409);
  }
  // #317 review, code-review follow-up: same 409 treatment as
  // IdempotencyKeyConflictError above -- a well-formed request that lost a
  // genuine race against another writer, not a server-side failure.
  if (err instanceof PromptTemplateConflictError) {
    return c.json({ error: err.message }, 409);
  }
  logServerError("server", err);
  return c.json({ error: SERVICE_UNAVAILABLE_MESSAGE }, 503);
});

// #368 (PR3 final review): cross-origin isolation, so WebR's SharedArrayBuffer
// channel is available where the browser supports it -- see useWebR.ts's own
// doc comment for why this is an optimization, not a hard requirement (webR
// falls back to its PostMessage channel without it, no service worker
// involved either way). Applied globally, not scoped to the chat routes,
// because COOP/COEP are page-level properties (the top-level document's
// headers, not a per-fetch header) -- Hono has no narrower unit to attach
// them to that would still take effect for the initial HTML response the
// ASSETS catch-all serves below.
//
// Verified safe for the one thing on this domain that could plausibly break
// under it: WorkOS AuthKit login (routes/auth.ts) is a full top-level
// redirect (c.redirect) to workos.com and back, not a popup or an iframe --
// COOP only constrains window.opener/postMessage relationships between open
// windows, and COEP only constrains subresources this page itself loads
// (this client has none cross-origin: grepped for external script/font/image
// URLs, found none besides webR's own now-self-hosted assets). `require-corp`
// over `credentialless`: nothing here needs to send credentials to a
// cross-origin subresource, so the stricter, better-supported mode has no
// downside.
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
});

// Session gate for every /api/* route except /api/auth/*.
app.use("/api/*", authMiddleware);
// Resolves course_memberships once per request for authenticated users.
app.use("/api/*", rolesMiddleware);

// API routes — registered directly on `app` rather than via app.route(prefix, sub)
// to avoid Hono's prefix-stripping behavior that can cause /api/hello to not
// match a sub-app's `/` handler.
app.get("/api/hello", helloHandler);
app.post("/api/chat", chatHandler);
app.get("/api/auth/login", loginHandler);
app.get("/api/auth/callback", callbackHandler);
app.post("/api/auth/logout", logoutHandler);
app.post("/api/webhooks/workos", workosWebhookHandler);
app.get("/api/profile", getProfileHandler);
app.patch("/api/profile", patchProfileHandler);
app.get("/api/courses/:courseId/homeworks", requireCourseMember()(listHomeworksHandler));
app.get("/api/courses/:courseId/prompt-template", requireInstructorOf()(getCoursePromptTemplateHandler));
app.put("/api/courses/:courseId/prompt-template", requireInstructorOf()(putCoursePromptTemplateHandler));
app.delete("/api/courses/:courseId/prompt-template", requireInstructorOf()(deleteCoursePromptTemplateHandler));
app.get("/api/courses/:courseId/llm-models", requireInstructorOf()(listLlmModelsHandler));
app.post("/api/courses/:courseId/homeworks", requireInstructorOf()(createHomeworkHandler));
app.get(
  "/api/courses/:courseId/homeworks/:homeworkId",
  requireCourseMember()(getHomeworkDetailHandler),
);
app.patch(
  "/api/courses/:courseId/homeworks/:homeworkId",
  requireInstructorOf()(updateHomeworkHandler),
);
app.delete(
  "/api/courses/:courseId/homeworks/:homeworkId",
  requireInstructorOf()(deleteHomeworkHandler),
);
app.patch(
  "/api/courses/:courseId/homeworks/:homeworkId/publish",
  requireInstructorOf()(publishHomeworkHandler),
);
app.patch(
  "/api/courses/:courseId/homeworks/:homeworkId/hide",
  requireInstructorOf()(updateHomeworkHideHandler),
);
app.get("/api/student/homeworks", requireRole(["student"])(studentHomeworksHandler));
app.get("/api/conversations", listConversationsHandler);
app.post("/api/conversations", createConversationHandler);
// #4 fix-round: message-history hydration for the tutor-conversations rail
// (see conversations.ts's doc comment above listConversationMessagesHandler).
app.get("/api/conversations/:id/messages", listConversationMessagesHandler);
app.patch("/api/conversations/:id", updateConversationHandler);
app.delete("/api/conversations/:id", deleteConversationHandler);
app.post("/api/conversations/:id/submit", requireRole(["student"])(submitSectionHandler));
// #172: grading reads, not authoring -- requireGraderOf admits `ta`
// alongside instructor/admin. Every content-mutating route above stays on
// requireInstructorOf.
app.get(
  "/api/courses/:courseId/homeworks/:homeworkId/submissions",
  requireGraderOf("gates-unreleased")(getHomeworkSubmissionsHandler),
);
// #27: section-conversation lifecycle. requireCourseMember, not
// requireRole(["student"]) -- an instructor starting one is the teacher-test
// case the isTeacherTest column exists for, and the handlers derive that from
// the caller's own course role. Per-conversation ownership and the
// grader-can't-read-another-grader's-test rule (#246: grader tier, not just
// instructor) are enforced inside the handlers (canReadSectionConversation),
// not by these guards, which only answer "is this caller in this course."
app.post(
  "/api/courses/:courseId/sections/:sectionId/conversations",
  requireCourseMember()(startSectionConversationHandler),
);
app.get(
  "/api/courses/:courseId/sections/:sectionId/conversation",
  requireCourseMember()(getActiveSectionConversationHandler),
);
app.get(
  "/api/courses/:courseId/conversations/:conversationId",
  requireCourseMember()(getSectionConversationHandler),
);
app.post(
  "/api/courses/:courseId/conversations/:conversationId/restart",
  requireCourseMember()(restartSectionConversationHandler),
);
// #29: instructor transcript viewer. Same grader tier as the submissions
// dashboard it drills in from (requireGraderOf) -- #246's own resolution for
// exactly this pairing. Per-conversation exclusions (a grader may not open
// another grader's teacher-test conversation) are enforced inside the detail
// handler via canReadSectionConversation, same split as every other guarded
// route above: these guards only answer "is this caller a grader of this
// course," not "of this specific conversation."
//
// #208/#366 merge: "gates-unreleased", not "no-unreleased-content" -- a
// transcript's own content (the greeting + replay, built from the section as
// it stood at conversation-start time) is unreleased content once the
// underlying homework is currently draft/scheduled/hidden, same as the
// homework's own title elsewhere in this console. Both handlers consult
// canViewDraftsIn themselves (see their own comments) before returning any
// row whose homework is currently unreleased.
app.get(
  "/api/courses/:courseId/instructor/transcripts",
  requireGraderOf("gates-unreleased")(listInstructorTranscriptsHandler),
);
app.get(
  "/api/courses/:courseId/instructor/transcripts/:conversationId",
  requireGraderOf("gates-unreleased")(getInstructorTranscriptHandler),
);
app.patch("/api/sections/:sectionId/answer", requireRole(["student"])(submitSectionAnswerHandler));
app.get(
  "/api/courses/:courseId/sections/:sectionId/answers/:studentId",
  requireGraderOf("gates-unreleased")(getSectionAnswerHandler),
);
app.patch("/api/widgets/:widgetId/response", requireRole(["student"])(submitWidgetResponseHandler));
// #80: read-only -- the caller's own hint usage for a section, driving
// Sidebar's real hintCount. requireCourseMember, not requireRole(["student"]),
// matching the section-conversation routes above: an instructor/TA teacher-
// testing a section still needs a real count for their own conversation.
app.get(
  "/api/courses/:courseId/sections/:sectionId/hints",
  requireCourseMember()(getSectionHintsHandler),
);
// #172: granting a capability is authoring-tier -- a TA must not be able to
// widen their own or another TA's access, so these stay requireInstructorOf.
app.get("/api/courses/:courseId/tas", requireInstructorOf()(listCourseTasHandler));
app.patch(
  "/api/courses/:courseId/tas/:membershipId/capabilities",
  requireInstructorOf()(updateTaCapabilitiesHandler),
);
// #210: putting someone on a course as a TA is authoring-tier authority over
// who can read student work, so these join the grant routes above rather than
// the grading reads -- a TA must not be able to recruit another TA or re-add
// themselves after removal.
app.post("/api/courses/:courseId/tas", requireInstructorOf()(addCourseTasHandler));
app.delete(
  "/api/courses/:courseId/tas/:membershipId",
  requireInstructorOf()(removeCourseTaHandler),
);

// #31/#170: LLM configuration authoring. Instructor-gated on the COURSE,
// operating on that course's ORGANIZATION pool -- llm_configs is a per-org
// resource, so an instructor of one course can edit configs other courses in
// the same org use, and can change the org default.
//
// #367: that widening is a TRACKED GAP, not an accepted design. It was
// documented as deliberate when this landed; #363's review rejected that
// framing -- the fix is an Org Admin role owning org-level config, with
// per-course instructors scoped to their own course, which is schema-level
// and so lands as its own change rather than inside a 105-file PR. These
// guards genuinely cannot narrow it in the meantime (the authority checked
// and the scope written are different keys), which is why it is filed
// rather than patched here.
app.get("/api/courses/:courseId/llm-configs", requireInstructorOf()(listLlmConfigsHandler));
app.post("/api/courses/:courseId/llm-configs", requireInstructorOf()(createLlmConfigHandler));
app.get(
  "/api/courses/:courseId/llm-configs/:configId",
  requireInstructorOf()(getLlmConfigHandler),
);
app.patch(
  "/api/courses/:courseId/llm-configs/:configId",
  requireInstructorOf()(updateLlmConfigHandler),
);
// DELETE deactivates; it never removes the row. homeworks.llm_config_id
// references these, and conversations record which config produced them.
app.delete(
  "/api/courses/:courseId/llm-configs/:configId",
  requireInstructorOf()(deactivateLlmConfigHandler),
);
app.post(
  "/api/courses/:courseId/llm-configs/:configId/clone",
  requireInstructorOf()(cloneLlmConfigHandler),
);
app.post(
  "/api/courses/:courseId/llm-configs/:configId/test",
  requireInstructorOf()(testLlmConfigHandler),
);

// #32/#86: the roster. Instructor-only -- a TA reads student work, they do
// not decide who is in the class. The import shares one provisioning
// pipeline with manual add and with #210's NetID entry (repositories/
// roster.ts), which is what stops the three inputs from drifting.
app.get("/api/courses/:courseId/roster", requireInstructorOf()(listRosterHandler));
app.post("/api/courses/:courseId/roster", requireInstructorOf()(addRosterMemberHandler));
app.post("/api/courses/:courseId/roster/import", requireInstructorOf()(importRosterHandler));
app.delete(
  "/api/courses/:courseId/roster/:membershipId",
  requireInstructorOf()(removeRosterMemberHandler),
);

// #75: grading. Instructor-tier, NOT grader-tier, unlike the submission
// reads above -- a TA may read a student's work, but a grade is a record the
// student may dispute and the institution may be asked to defend, so it is
// attributed to someone with authority over the course. If TA grading is
// ever wanted it should be a per-course grant like canViewSolutions rather
// than a widening of these guards.
app.get(
  "/api/courses/:courseId/submissions/:submissionId/grades",
  requireInstructorOf()(listGradesHandler),
);
app.post(
  "/api/courses/:courseId/submissions/:submissionId/grades",
  requireInstructorOf()(saveGradeHandler),
);
app.post(
  "/api/courses/:courseId/submissions/:submissionId/grades/draft",
  requireInstructorOf()(draftGradeHandler),
);

// #91: export. Instructor-tier: the artifact leaves the platform's control
// the moment it is downloaded, so who may create one is a narrower question
// than who may read the same data inside the console.
app.post("/api/courses/:courseId/exports", requireInstructorOf()(createExportHandler));

// #172 audit (CMP-005): an unmatched /api/* path fell through to the SPA
// catch-all below, which serves index.html with a 200. A client calling a
// route its server doesn't have yet -- the realistic rolling-deploy skew
// when the admin bundle leads the Worker -- therefore saw `r.ok === true`
// and only failed when JSON.parse choked on HTML. That failed closed by
// accident of content type, not by design. A JSON 404 makes a missing API
// route unambiguous for every current and future client.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Everything else: delegate to the static asset binding.
// In dev, this proxies to Vite's pipeline (so HMR + source maps work).
// In prod, it serves built assets, falling back to index.html for SPA routes
// per the `not_found_handling: "single-page-application"` setting in wrangler.jsonc.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
