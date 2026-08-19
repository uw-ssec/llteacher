/* --------------------------------------------------------------------------
   GET /api/courses/:courseId/llm-models

   Lists the models the platform's LLMoxie gateway currently serves, so an
   instructor picking a model chooses from what the gateway actually offers
   rather than from a hand-maintained list that silently rots.

   The point of doing this server-side is the credential. The gateway key is
   a platform secret; instructors must be able to *use* the gateway without
   ever being able to read, extract, or redirect its key. So the worker calls
   the gateway itself and returns model ids only -- the key is read into a
   local at the moment of use and never reaches a response body, a log line,
   or the client. That boundary is the same one listLlmConfigsHandler already
   holds by mapping `credentialId`/`secretRef` out of its response.

   Deliberately platform-only. This route resolves the gateway key from the
   LLMOXIE_API_KEY binding and nothing else: it never reads
   organization_credentials, so it cannot be pointed at an instructor-supplied
   endpoint or made to spend an instructor-supplied credential. Discovery for
   instructor-owned providers is a separate problem and needs the secret_ref
   allowlist (#323) landed first.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { LLMOXIE_DEFAULT_BASE_URL } from "../../lib/ai";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

/** The gateway can be slow or unreachable; a model picker is not worth
 *  holding a worker request open indefinitely for. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/** LiteLLM returns OpenAI's `/v1/models` shape: `{ object, data: [{ id, ...}] }`.
 *  Only `id` is consumed -- it is the string that goes into
 *  `llm_configs.model_name` -- so the rest is deliberately not modelled. */
interface ModelListResponse {
  models: string[];
}

export async function listLlmModelsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified this; guarded again here to match
  // every sibling authoring-surface handler.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const apiKey = c.env.LLMOXIE_API_KEY;
  if (!apiKey) {
    // Names the binding, never a value -- same convention as
    // LLMCredentialMissingError's message.
    logServerError(
      "listLlmModelsHandler",
      new Error('Secret "LLMOXIE_API_KEY" is not set'),
    );
    return c.json(
      { error: "The model gateway is not configured for this deployment." },
      503,
    );
  }

  const baseUrl = c.env.LLMOXIE_BASE_URL || LLMOXIE_DEFAULT_BASE_URL;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (err) {
    // Covers both the timeout and a DNS/TLS failure. The gateway host is a
    // generated Azure name that does not survive its environment being
    // recreated, so "unreachable" is a state worth naming in the log.
    logServerError("listLlmModelsHandler.fetch", err);
    return c.json({ error: "Could not reach the model gateway." }, 502);
  }

  if (!res.ok) {
    // Body is not forwarded: an upstream error body can carry gateway detail
    // the instructor has no business seeing, and this is the same
    // information-disclosure shape the audit flagged on the chat stream.
    logServerError(
      "listLlmModelsHandler.upstream",
      new Error(`Gateway returned ${res.status}`),
    );
    return c.json({ error: "The model gateway rejected the request." }, 502);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    logServerError("listLlmModelsHandler.parse", err);
    return c.json({ error: "The model gateway returned an unreadable response." }, 502);
  }

  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    logServerError(
      "listLlmModelsHandler.shape",
      new Error("Gateway response had no `data` array"),
    );
    return c.json({ error: "The model gateway returned an unexpected response." }, 502);
  }

  const models = data
    .map((m) => (typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const body: ModelListResponse = { models };
  return c.json(body);
}
