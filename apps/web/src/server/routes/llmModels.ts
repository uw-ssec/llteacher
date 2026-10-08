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

import { Effect } from "effect";
import { LLMOXIE_DEFAULT_BASE_URL } from "../../lib/ai";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import { ExternalServiceError, Forbidden } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external } from "../effect/services";

/** The gateway can be slow or unreachable; a model picker is not worth
 *  holding a worker request open indefinitely for. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/** LiteLLM returns OpenAI's `/v1/models` shape: `{ object, data: [{ id, ...}] }`.
 *  Only `id` is consumed -- it is the string that goes into
 *  `llm_configs.model_name` -- so the rest is deliberately not modelled. */
interface ModelListResponse {
  models: string[];
}

/** Each way the gateway call can fail, keyed by the ExternalServiceError
 *  `operation` that names it, with the sentence the client is told. All of
 *  them are 502: the gateway, not this server, is what failed. */
const GATEWAY_FAILURES: Record<string, string> = {
  fetch: "Could not reach the model gateway.",
  upstream: "The model gateway rejected the request.",
  parse: "The model gateway returned an unreadable response.",
  shape: "The model gateway returned an unexpected response.",
};

const gatewayFailure = (operation: keyof typeof GATEWAY_FAILURES, cause: unknown) =>
  new ExternalServiceError({ service: "llm", operation, cause });

export const listLlmModelsHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified this; guarded again here to match
  // every sibling authoring-surface handler.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Course access denied" });
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

  return yield* Effect.gen(function* () {
    // A rejection covers both the timeout and a DNS/TLS failure. The gateway
    // host is a generated Azure name that does not survive its environment
    // being recreated, so "unreachable" is a state worth naming in the log.
    const res = yield* external("llm", "fetch", () =>
      fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      }),
    );

    if (!res.ok) {
      // Body is not forwarded: an upstream error body can carry gateway detail
      // the instructor has no business seeing, and this is the same
      // information-disclosure shape the audit flagged on the chat stream.
      return yield* gatewayFailure("upstream", new Error(`Gateway returned ${res.status}`));
    }

    const payload: unknown = yield* external("llm", "parse", () => res.json());

    const data = (payload as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return yield* gatewayFailure("shape", new Error("Gateway response had no `data` array"));
    }

    const models = data
      .map((m) => (typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort((a, b) => a.localeCompare(b));

    const body: ModelListResponse = { models };
    return c.json(body);
  }).pipe(Effect.catchTag("ExternalServiceError", (err) => Effect.sync(() => {
    // 502 with its own sentence rather than the bridge's generic 503: the
    // instructor's picker shows which of these happened.
    logServerError(`listLlmModelsHandler.${err.operation}`, err.cause);
    return c.json({ error: GATEWAY_FAILURES[err.operation] ?? GATEWAY_FAILURES.fetch }, 502);
  })));
}));
