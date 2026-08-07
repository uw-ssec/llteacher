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
import { studentHomeworksHandler } from "./routes/studentHomeworks";
import { submitSectionHandler, getHomeworkSubmissionsHandler } from "./routes/submissions";
import { submitSectionAnswerHandler, getSectionAnswerHandler } from "./routes/sectionAnswers";
import { authMiddleware } from "./middleware/auth";
import { rolesMiddleware } from "./middleware/roles";
import { requireCourseMember, requireInstructorOf, requireRole } from "./utils/guards";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "./utils/errors";
import type { AppEnv } from "./context";

const app = new Hono<AppEnv>();

// Catches anything thrown by middleware/handlers that isn't already handled
// locally -- e.g. a DB connection failure in rolesMiddleware or a profile
// route. Logs the real error server-side; the client only ever sees the
// generic message, never DB connection strings or driver internals.
app.onError((err, c) => {
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
app.post("/api/conversations/:id/submit", requireRole(["student"])(submitSectionHandler));
app.get(
  "/api/courses/:courseId/homeworks/:homeworkId/submissions",
  requireInstructorOf()(getHomeworkSubmissionsHandler),
);
app.patch("/api/sections/:sectionId/answer", requireRole(["student"])(submitSectionAnswerHandler));
app.get(
  "/api/courses/:courseId/sections/:sectionId/answers/:studentId",
  requireInstructorOf()(getSectionAnswerHandler),
);

// Everything else: delegate to the static asset binding.
// In dev, this proxies to Vite's pipeline (so HMR + source maps work).
// In prod, it serves built assets, falling back to index.html for SPA routes
// per the `not_found_handling: "single-page-application"` setting in wrangler.jsonc.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
