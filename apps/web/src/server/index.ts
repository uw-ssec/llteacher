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
import { submitWidgetResponseHandler } from "./routes/progressWidgets";
import { listCourseTasHandler, updateTaCapabilitiesHandler } from "./routes/courseMemberships";
import { listLlmConfigsHandler } from "./routes/llmConfigs";
import { listLlmModelsHandler } from "./routes/llmModels";
import { authMiddleware } from "./middleware/auth";
import { rolesMiddleware } from "./middleware/roles";
import { requireCourseMember, requireGraderOf, requireInstructorOf, requireRole } from "./utils/guards";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "./utils/errors";
import { TenancyMismatchError, IdempotencyKeyConflictError } from "./repositories/errors";
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
  if (err instanceof IdempotencyKeyConflictError) {
    return c.json({ error: err.message }, 409);
  }
  logServerError("server", err);
  return c.json({ error: SERVICE_UNAVAILABLE_MESSAGE }, 503);
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
app.get("/api/courses/:courseId/llm-configs", requireInstructorOf()(listLlmConfigsHandler));
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
  requireGraderOf()(getHomeworkSubmissionsHandler),
);
// #27: section-conversation lifecycle. requireCourseMember, not
// requireRole(["student"]) -- an instructor starting one is the teacher-test
// case the isTeacherTest column exists for, and the handlers derive that from
// the caller's own course role. Per-conversation ownership and the
// instructor-can't-read-another-instructor's-test rule are enforced inside
// the handlers (canReadSectionConversation), not by these guards, which only
// answer "is this caller in this course."
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
app.patch("/api/sections/:sectionId/answer", requireRole(["student"])(submitSectionAnswerHandler));
app.get(
  "/api/courses/:courseId/sections/:sectionId/answers/:studentId",
  requireGraderOf()(getSectionAnswerHandler),
);
app.patch("/api/widgets/:widgetId/response", requireRole(["student"])(submitWidgetResponseHandler));
// #172: granting a capability is authoring-tier -- a TA must not be able to
// widen their own or another TA's access, so these stay requireInstructorOf.
app.get("/api/courses/:courseId/tas", requireInstructorOf()(listCourseTasHandler));
app.patch(
  "/api/courses/:courseId/tas/:membershipId/capabilities",
  requireInstructorOf()(updateTaCapabilitiesHandler),
);

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
