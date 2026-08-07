import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { submitWidgetResponse } from "../repositories/progressWidgets";
import { getOrgScopesForUser } from "../repositories/users";
import { requireRole } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { WidgetResponseBody, WidgetResponseResponse } from "../../shared/types";

export async function submitWidgetResponseHandler(c: Context<AppEnv>) {
  const widgetId = c.req.param("widgetId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireRole(["student"]) already verified this when reached via the
  // guarded production route; re-checked here -- mirrors
  // submitSectionAnswerHandler (routes/sectionAnswers.ts) -- so the handler
  // fails closed even if reached unguarded.
  if (!authContext || !authContext.hasRole("student")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: WidgetResponseBody;
  try {
    body = await c.req.json<WidgetResponseBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (body.which !== "pre" && body.which !== "post") {
    return c.json({ error: "which must be \"pre\" or \"post\"" }, 400);
  }
  if (typeof body.value !== "number" || !Number.isInteger(body.value) || body.value < 0 || body.value > 10) {
    return c.json({ error: "value must be an integer between 0 and 10" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);
  // Same single-org-per-user assumption submitSectionAnswerHandler already
  // makes -- submitWidgetResponse's own ownership check via the real
  // parent chain is what actually narrows this to the right org.
  const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
  const orgScope = orgScopes[0];
  if (!orgScope) return c.json({ error: "No organization membership found" }, 403);

  try {
    const response = await submitWidgetResponse(db, orgScope, widgetId!, authContext.session.userId, {
      which: body.which,
      value: body.value,
    });
    const responseBody: WidgetResponseResponse = {
      id: response.id,
      widgetId: response.widgetId,
      userId: response.userId,
      preValue: response.preValue,
      preSubmittedAt: response.preSubmittedAt?.toISOString() ?? null,
      postValue: response.postValue,
      postSubmittedAt: response.postSubmittedAt?.toISOString() ?? null,
    };
    return c.json(responseBody);
  } catch {
    // Uniform 403 -- same rationale as submitSectionAnswerHandler: don't
    // let a not-found distinction leak widget existence.
    return c.json({ error: "Widget not found in this org scope" }, 403);
  }
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.patch(...) in server/index.ts (see sectionAnswers.ts for the same
// pattern).
export const progressWidgetsRoutes = new Hono<AppEnv>();
progressWidgetsRoutes.patch("/api/widgets/:widgetId/response", requireRole(["student"])(submitWidgetResponseHandler));
