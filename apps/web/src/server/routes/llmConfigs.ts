/* --------------------------------------------------------------------------
   LLM configuration CRUD (#31), cloning (#170), and the test button.

   Ports the Django llm app's views (config_list / detail / form / test) onto
   the worker. Two deliberate departures from that parity, both recorded in
   #31:

     · Configs are deactivated, never deleted. `homeworks.llm_config_id`
       points at these rows and conversations record which config produced
       them, so a delete would either orphan or cascade -- neither is what an
       instructor means by "stop using this one".

     · No plaintext API-key column. Django stored one on the config; ours
       carries a `credential_id` pointing at `organization_credentials`,
       whose `secret_ref` names a secrets-manager entry. Nothing in this file
       accepts, returns, or logs key material. The form does not collect a
       credential at all yet -- see LLMConfigFormView's header and #332/#323
       for why instructor-supplied credentials are gated behind a secret_ref
       allowlist.

   AUTHORIZATION SHAPE -- a widening, and as of #367 a TRACKED GAP rather
   than an accepted design. These routes gate on instructor-of-COURSE and
   then operate on that course's ORGANIZATION pool, because that is what
   `llm_configs` is. So an instructor of one course can edit configs other
   courses in the same org use, and can change the org default.

   This block previously argued the widening was fine -- "within one UW
   organization, course staff are trusted with the shared model pool."
   #363's review rejected that: the authority a course instructor holds
   should not reach org-level state just because the schema stores it
   per-org. The fix is an Org Admin role that owns org-level config, with
   per-course instructors scoped strictly to their own course (#367).
   Schema-level, so it lands separately rather than inside this PR.

   Nothing here can narrow it in the meantime: the authority being checked
   and the scope being written are different keys, so a filter would either
   be a no-op or lock instructors out of the pool entirely. Do not read the
   absence of a guard as a decision that one is not wanted.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { Effect } from "effect";
import { generateText } from "ai";
import { UUID_RE } from "../utils/uuid";
import {
  cloneLlmConfig,
  createLlmConfig,
  deactivateLlmConfig,
  getLlmConfig,
  listLlmConfigsForOrg,
  updateLlmConfig,
  type LlmConfigInput,
} from "../repositories/llmConfigs";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import {
  loadLLMConfigById,
  resolveApiKey,
  buildProviderClient,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
} from "../../lib/llm-config";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { OrgScope } from "../repositories/scope";
import type {
  LlmConfigBody,
  LlmConfigCloneBody,
  LlmConfigListResponse,
  LlmConfigTestBody,
  LlmConfigTestResponse,
} from "../../shared/types";
import { BadRequest, Conflict, DatabaseError, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external, query, type Database } from "../effect/services";
import { isToolkitId, normalizeToolkitIds } from "@llteacher/ui/generative/toolkits";

/** #31: the temperature and token bounds the form offers, restated as the
 *  server's own rule. `llm_configs_temperature_range_chk` covers temperature
 *  in the database; these produce a sentence an instructor can act on
 *  instead of a constraint violation surfacing as a 503. */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const MAX_COMPLETION_TOKENS_MIN = 100;
const MAX_COMPLETION_TOKENS_MAX = 8000;
const NAME_MAX = 200;
const BASE_PROMPT_MAX = 128 * 1024;

/** The providers the schema enum admits. Restated rather than derived from
 *  the Drizzle enum object so that adding a provider to the database is a
 *  deliberate two-step -- the second step being a decision about whether the
 *  gateway can actually reach it. */
const PROVIDERS = [
  "openai",
  "anthropic",
  "claude_for_education",
  "openrouter",
  "local",
] as const;

type Provider = (typeof PROVIDERS)[number];

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

type InstructorOrgCtx = { scope: OrgScope; courseId: string; authContext: AuthContext };

/** Resolves the caller's authority (a course) into the scope these routes
 *  operate on (that course's org). Fails Forbidden for anything that should
 *  be a 403 -- no auth context, no course, not an instructor of it, or a
 *  course that resolves to no org (fails closed: an unresolvable org must
 *  not become an unscoped query). */
function orgScopeForInstructor(
  c: Context<AppEnv>,
): Effect.Effect<InstructorOrgCtx, Forbidden | DatabaseError, Database> {
  return Effect.gen(function* () {
    const denied = () => new Forbidden({ message: "Instructor access denied" });
    const courseId = c.req.param("courseId");
    const authContext = c.get("authContext") as AuthContext | undefined;
    if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return yield* denied();
    const scope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    if (!scope) return yield* denied();
    return { scope, courseId, authContext };
  });
}

/** Unparseable JSON is the caller's fault, not a dependency failure. */
function readJsonBody<T>(c: Context<AppEnv>): Effect.Effect<T, BadRequest> {
  return Effect.tryPromise({
    try: () => c.req.json<T>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
}

/** Same sentence for a malformed id and a genuine miss (SEC-003): shape is
 *  never an existence oracle. */
const configNotFound = () => new NotFound({ message: "That configuration no longer exists." });

/** SEC-003's shape check: a non-UUID would reach a uuid-typed comparison
 *  and surface as a 503 for a permanently malformed request. */
function requireConfigId(c: Context<AppEnv>): Effect.Effect<string, NotFound> {
  const configId = c.req.param("configId");
  return configId && UUID_RE.test(configId) ? Effect.succeed(configId) : Effect.fail(configNotFound());
}

/** Validates a create/update body into the repository's input shape, or
 *  returns a sentence naming the field at fault.
 *
 *  Every numeric field is checked for finiteness explicitly: JSON admits
 *  `1e999`, which parses to Infinity, passes a naive `>= 0 && <= 2`
 *  comparison for the wrong reason, and reaches a doubleprecision column. */
function parseConfigBody(raw: unknown): { input: LlmConfigInput } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Request body must be an object" };
  const b = raw as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { error: "Give this configuration a name." };
  if (name.length > NAME_MAX) return { error: `Name must be ${NAME_MAX} characters or fewer.` };

  if (!isProvider(b.provider)) return { error: "Choose a provider." };

  const modelName = typeof b.modelName === "string" ? b.modelName.trim() : "";
  if (!modelName) return { error: "Enter a model id." };

  const basePrompt = typeof b.basePrompt === "string" ? b.basePrompt : "";
  if (basePrompt.length > BASE_PROMPT_MAX) {
    return { error: "That base prompt is too long. A system prompt is prose, not a document." };
  }

  const temperature = typeof b.temperature === "number" ? b.temperature : NaN;
  if (!Number.isFinite(temperature) || temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX) {
    return { error: `Temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}.` };
  }

  const maxCompletionTokens =
    typeof b.maxCompletionTokens === "number" ? b.maxCompletionTokens : NaN;
  if (
    !Number.isInteger(maxCompletionTokens) ||
    maxCompletionTokens < MAX_COMPLETION_TOKENS_MIN ||
    maxCompletionTokens > MAX_COMPLETION_TOKENS_MAX
  ) {
    return {
      error: `Reply length must be a whole number between ${MAX_COMPLETION_TOKENS_MIN} and ${MAX_COMPLETION_TOKENS_MAX} tokens.`,
    };
  }

  const fallbackRaw = b.fallbackLlmConfigId;
  if (fallbackRaw !== null && fallbackRaw !== undefined && typeof fallbackRaw !== "string") {
    return { error: "fallbackLlmConfigId must be a config id or null" };
  }
  const fallbackLlmConfigId =
    typeof fallbackRaw === "string" && fallbackRaw !== "" ? fallbackRaw : null;
  if (fallbackLlmConfigId && !UUID_RE.test(fallbackLlmConfigId)) {
    return { error: "That fallback configuration id is not valid." };
  }

  // Booleans checked rather than coerced: an uncontrolled checkbox sending
  // "" or "on" would otherwise be read as a value the instructor never chose
  // -- the same class of bug #154's review found with llmConfigId.
  if (typeof b.isActive !== "boolean") return { error: "isActive must be a boolean" };
  if (typeof b.isDefault !== "boolean") return { error: "isDefault must be a boolean" };

  // #31: the database rejects an inactive default
  // (llm_configs_active_required_for_default_chk). Caught here so the
  // instructor reads an instruction rather than a constraint name.
  if (b.isDefault && !b.isActive) {
    return {
      error: "A configuration must be active to be the default. Activate it, or choose another default.",
    };
  }

  // Optional so older clients keep working; default on, matching the column.
  if (b.knowledgeEnabled !== undefined && typeof b.knowledgeEnabled !== "boolean") {
    return { error: "knowledgeEnabled must be a boolean" };
  }

  // Optional so older clients keep working (an update without it keeps the
  // stored packs). Unknown ids are refused, not silently dropped: the
  // instructor should hear that a pack they picked doesn't exist.
  let genuiToolkits: string[] | undefined;
  if (b.genuiToolkits !== undefined) {
    if (!Array.isArray(b.genuiToolkits) || !b.genuiToolkits.every((t) => typeof t === "string")) {
      return { error: "genuiToolkits must be a list of subject figure pack ids" };
    }
    const unknown = b.genuiToolkits.filter((t) => !isToolkitId(t));
    if (unknown.length > 0) return { error: `Unknown subject figure pack: ${unknown.join(", ")}` };
    genuiToolkits = normalizeToolkitIds(b.genuiToolkits);
  }

  return {
    input: {
      name,
      provider: b.provider,
      modelName,
      basePrompt,
      temperature,
      maxCompletionTokens,
      fallbackLlmConfigId,
      isActive: b.isActive,
      isDefault: b.isDefault,
      knowledgeEnabled: b.knowledgeEnabled ?? true,
      genuiToolkits,
    },
  };
}

/** The partial unique index is the real single-default enforcement, so two
 *  instructors promoting different configs at once means the loser's write
 *  raises a constraint violation. That is a conflict, not a server fault --
 *  reporting it as a 503 "try again later" would be true but useless, since
 *  what they should do is reload and see who won. */
function isDefaultConflict(err: unknown): boolean {
  return String((err as Error)?.message ?? "").includes("llm_configs_org_default_uq");
}

/** query()'s DatabaseError, with the one constraint violation request input
 *  can provoke (the default race above) translated to a 409. Any other
 *  database failure stays a DatabaseError and is answered 503. */
function translateDefaultRace<A, R>(
  self: Effect.Effect<A, DatabaseError, R>,
): Effect.Effect<A, Conflict | DatabaseError, R> {
  return self.pipe(
    Effect.catchTag("DatabaseError", (err): Effect.Effect<never, Conflict | DatabaseError> =>
      isDefaultConflict(err.cause)
        ? Effect.fail(
            new Conflict({ message: "Someone else changed the default configuration. Reload and try again." }),
          )
        : Effect.fail(err),
    ),
  );
}

/** Rejects a fallback outside the caller's org. The FK only requires the
 *  row to exist SOMEWHERE. Same gap #161 found with homeworks.llm_config_id:
 *  without this, a config could name another organization's config as its
 *  fallback, and a provider outage would then quietly run students on a
 *  tenant they have no relationship with. */
function requireFallbackInOrg(
  ctx: InstructorOrgCtx,
  fallbackLlmConfigId: string | null,
): Effect.Effect<void, BadRequest | DatabaseError, Database> {
  return Effect.gen(function* () {
    if (!fallbackLlmConfigId) return;
    const fallback = yield* query("getLlmConfig", (db) => getLlmConfig(db, ctx.scope, fallbackLlmConfigId));
    if (!fallback) return yield* new BadRequest({ message: "That fallback configuration no longer exists." });
  });
}

export const listLlmConfigsHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configs = yield* query("listLlmConfigsForOrg", (db) => listLlmConfigsForOrg(db, ctx.scope));
  const body: LlmConfigListResponse = { configs };
  return c.json(body);
}));

export const getLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configId = yield* requireConfigId(c);

  const config = yield* query("getLlmConfig", (db) => getLlmConfig(db, ctx.scope, configId));
  if (!config) return yield* configNotFound();
  return c.json(config);
}));

export const createLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);

  const raw = yield* readJsonBody<LlmConfigBody>(c);
  const parsed = parseConfigBody(raw);
  if ("error" in parsed) return yield* new BadRequest({ message: parsed.error });

  yield* requireFallbackInOrg(ctx, parsed.input.fallbackLlmConfigId);

  const created = yield* query("createLlmConfig", (db) => createLlmConfig(db, ctx.scope, parsed.input)).pipe(
    translateDefaultRace,
  );

  yield* auditConfigChange(ctx, AUDIT_ACTIONS.LLM_CONFIG_CREATED, created.id, {
    name: created.name,
    isDefault: created.isDefault,
  });
  return c.json(created, 201);
}));

export const updateLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configId = yield* requireConfigId(c);

  const raw = yield* readJsonBody<LlmConfigBody>(c);
  const parsed = parseConfigBody(raw);
  if ("error" in parsed) return yield* new BadRequest({ message: parsed.error });

  if (parsed.input.fallbackLlmConfigId === configId) {
    // The schema rejects this too (llm_configs_fallback_not_self_chk); this
    // is the sentence that says why rather than a constraint name.
    return yield* new BadRequest({ message: "A configuration cannot be its own fallback." });
  }

  yield* requireFallbackInOrg(ctx, parsed.input.fallbackLlmConfigId);

  const updated = yield* query(
    "updateLlmConfig",
    (db) => updateLlmConfig(db, ctx.scope, configId, parsed.input),
  ).pipe(translateDefaultRace);
  if (!updated) return yield* configNotFound();

  yield* auditConfigChange(ctx, AUDIT_ACTIONS.LLM_CONFIG_UPDATED, updated.id, {
    name: updated.name,
    isDefault: updated.isDefault,
    isActive: updated.isActive,
  });
  return c.json(updated);
}));

export const deactivateLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configId = yield* requireConfigId(c);

  const outcome = yield* query("deactivateLlmConfig", (db) => deactivateLlmConfig(db, ctx.scope, configId));
  if (outcome === "not_found") return yield* configNotFound();
  if (outcome === "is_default") {
    // 409, not 403: the caller is entitled to do this, the org's state just
    // does not permit it yet. The sentence names the unblocking step.
    return yield* new Conflict({
      message:
        "This is the default configuration for your organization. Make another configuration the default first, then deactivate this one.",
    });
  }

  yield* auditConfigChange(ctx, AUDIT_ACTIONS.LLM_CONFIG_DEACTIVATED, configId, {});
  return c.json({ id: configId, isActive: false });
}));

export const cloneLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configId = yield* requireConfigId(c);

  const body = yield* readJsonBody<LlmConfigCloneBody>(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return yield* new BadRequest({ message: "Give the copy a name." });
  if (name.length > NAME_MAX) {
    return yield* new BadRequest({ message: `Name must be ${NAME_MAX} characters or fewer.` });
  }

  const clone = yield* query("cloneLlmConfig", (db) => cloneLlmConfig(db, ctx.scope, configId, name));
  // Null covers "no such config" and "another organization's config"
  // indistinguishably -- cloning must not become a way to read across
  // tenants, not even to learn that an id exists.
  if (!clone) return yield* configNotFound();

  yield* auditConfigChange(ctx, AUDIT_ACTIONS.LLM_CONFIG_CREATED, clone.id, {
    name: clone.name,
    clonedFrom: configId,
  });
  return c.json(clone, 201);
}));

/** #31: "Test configuration" -- one non-streaming generation against the
 *  config as saved, returning the reply text and token usage.
 *
 *  Not streamed, deliberately, and not the same shape as /api/chat. The
 *  instructor is answering "does this configuration work and does it sound
 *  right", which is a single artifact they read once -- streaming it would
 *  add the whole partial-output and mid-stream-failure surface for no gain
 *  on a one-shot. `generateText` also gives usage numbers, which a stream
 *  only exposes at the end.
 *
 *  Persists nothing. This is a dry run: no conversation, no message rows.
 *  The one thing it does write is an audit event, because it spends money
 *  and touches a provider.
 *
 *  Bounded by an AbortSignal well inside the Workers wall clock, so a slow
 *  or hung model returns a stated timeout rather than the platform killing
 *  the request and the instructor seeing nothing. */
const TEST_SEND_TIMEOUT_MS = 25_000;
const TEST_MESSAGE_MAX = 4_000;

export const testLlmConfigHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);
  const configId = yield* requireConfigId(c);

  const body = yield* readJsonBody<LlmConfigTestBody>(c);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return yield* new BadRequest({ message: "Enter a message to send." });
  if (message.length > TEST_MESSAGE_MAX) {
    return yield* new BadRequest({ message: `Test messages are limited to ${TEST_MESSAGE_MAX} characters.` });
  }

  // #365: `loadLLMConfigById`, not the console's own `getLlmConfig`. This
  // handler needs the row's `credentialId` (which the console's wire shape
  // deliberately does not carry) to resolve a key at all, and reading it
  // through the same primitive chat.ts's resolution uses keeps the
  // provider/credential rule in exactly one place. `activeOnly: false`:
  // testing a retired config before reactivating it is precisely what this
  // button is for, and it serves no student traffic -- the previous
  // `getLlmConfig` read didn't filter on isActive either, so this preserves
  // that behaviour rather than tightening it as a side effect.
  const config = yield* query(
    "loadLLMConfigById",
    (db) => loadLLMConfigById(db, ctx.scope, configId, { activeOnly: false }),
  );
  if (!config) return yield* configNotFound();

  // #365: previously hardcoded `getOpenRouter(c.env.OPENROUTER_API_KEY)`
  // regardless of what the config actually said. Since migration 0035 every
  // organization's default config is `llmoxie`/`gpt-5.3-codex`, so pressing
  // Test on the default sent an LLMOxie model id to openrouter.ai under an
  // OpenRouter key -- wrong provider, wrong credential, and an error message
  // ("check the model id") that pointed the instructor at the one thing that
  // was correct. The result was not a broken button but a lying one:
  // whatever came back said nothing about whether the configuration under
  // test actually works, which is the button's entire purpose -- a pass
  // could mean OpenRouter happens to front a same-named model, and a failure
  // looked like a bad model id rather than a misdirected request. Resolved
  // through the same `resolveApiKey` + `buildProviderClient` pair chat.ts
  // uses, so the button now tests what a student's turn would actually hit,
  // with the config's own credential rather than the deployment-wide key
  // when it has one.
  //
  // #390 (staging PR #382's follow-up): everything below reads off the ONE
  // `loadLLMConfigById` row above -- provider and credentialId for the
  // client, modelName/basePrompt/temperature/maxCompletionTokens for the
  // generation. There is deliberately no second `getLlmConfig` read to pair
  // with it, so an admin editing the config mid-request cannot make this
  // handler run a hybrid of the old provider and the new model.
  const resolved = yield* Effect.gen(function* () {
    const apiKey = yield* query(
      "resolveApiKey",
      (db) => resolveApiKey(c.env, db, ctx.scope, config),
      [LLMCredentialMissingError],
    );
    // #333: only consulted for the llmoxie provider; ignored for every other.
    return yield* external(
      "llm",
      "buildProviderClient",
      async () => buildProviderClient(config.provider, apiKey, { llmoxieBaseUrl: c.env.LLMOXIE_BASE_URL })(
        config.modelName,
      ),
      [UnsupportedLLMProviderError],
    );
  }).pipe(
    Effect.map((model) => ({ model })),
    Effect.catch((err) => {
      if (err._tag === "LLMCredentialMissingError" || err._tag === "UnsupportedLLMProviderError") {
        // Same 503 + sentence the missing-OPENROUTER_API_KEY branch produced,
        // now covering every way this config can be unreachable: no credential
        // and no fallback binding for its provider, a stale/cross-org
        // credentialId, a secret_ref off the allowlist (#323), or a provider
        // this deployment has no client factory for (#325). The message stays
        // deliberately generic -- err.message names bindings and config ids,
        // which is server-log material, not console copy.
        logServerError("testLlmConfigHandler", err);
        return Effect.succeed({
          response: c.json({ error: "The model gateway is not configured. Contact an administrator." }, 503),
        });
      }
      /* #425: resolveApiKey does a DB read (organization_credentials), so a
         transient database failure lands here too (a DatabaseError, or an
         ExternalServiceError from building the client). Reported as the
         same 503 the other unreachable cases produce rather than the generic
         one: from the admin's side "we could not check right now" is the
         honest answer, and the real error is in the log. Kept distinct from
         the sentence above so an unrelated failure is never reported to the
         instructor as a gateway misconfiguration they would then go and
         "fix". */
      logServerError("testLlmConfigHandler", err.cause);
      return Effect.succeed({
        response: c.json({ error: "The model gateway could not be reached. Try again shortly." }, 503),
      });
    }),
  );
  if ("response" in resolved) return resolved.response;
  const { model } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_SEND_TIMEOUT_MS);
  const result = yield* external("llm", "generateText", () =>
    generateText({
      model,
      // The config's own prompt is what is under test. An empty one is a
      // legitimate state (the column defaults to ''), and sending no system
      // message is the honest representation of it.
      ...(config.basePrompt ? { system: config.basePrompt } : {}),
      messages: [{ role: "user", content: message }],
      temperature: config.temperature,
      maxOutputTokens: config.maxCompletionTokens,
      abortSignal: controller.signal,
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => clearTimeout(timer))),
    Effect.map((generated) => ({ generated })),
    Effect.catchTag("ExternalServiceError", (err) => {
      // The provider's own message is NOT forwarded: it can carry request
      // urls, org identifiers and occasionally key prefixes. Logged
      // server-side, summarised to the instructor as the two things they can
      // act on -- the model id was wrong, or the provider did not answer.
      logServerError("testLlmConfigHandler", err.cause);
      const timedOut = controller.signal.aborted;
      const response: LlmConfigTestResponse = {
        ok: false,
        modelName: config.modelName,
        error: timedOut
          ? `The model did not answer within ${TEST_SEND_TIMEOUT_MS / 1000} seconds. It may be overloaded, or the model id may not exist.`
          : "The model gateway rejected that request. Check the model id, then try again.",
      };
      // 200 with ok:false: the *request* succeeded and produced a result the
      // instructor needs to read. A 5xx here would be indistinguishable from
      // the console being broken, which is the opposite of what a test button
      // is for.
      return Effect.succeed({ response: c.json(response) });
    }),
  );
  if ("response" in result) return result.response;

  yield* auditConfigChange(ctx, AUDIT_ACTIONS.LLM_CONFIG_TESTED, configId, {
    modelName: config.modelName,
  });

  const response: LlmConfigTestResponse = {
    ok: true,
    text: result.generated.text,
    modelName: config.modelName,
    usage: {
      inputTokens: result.generated.usage?.inputTokens ?? null,
      outputTokens: result.generated.usage?.outputTokens ?? null,
    },
  };
  return c.json(response);
}));

/** Best-effort (#147), scoped to the course's org rather than fanned out
 *  (SEC-002). A config change is an org-level act with real blast radius --
 *  the default is what every unpinned course runs on -- so it is audited,
 *  but an audit outage must not fail a save that already landed: a
 *  DatabaseError here is logged and swallowed, never answered 503. */
function auditConfigChange(
  ctx: InstructorOrgCtx,
  action: string,
  configId: string,
  metadata: Record<string, unknown>,
): Effect.Effect<void, never, Database> {
  return query("auditBestEffort", (db) =>
    auditBestEffort(db, [ctx.scope], {
      actorUserId: ctx.authContext.session.userId,
      action,
      targetType: AUDIT_TARGET_TYPES.LLM_CONFIG,
      targetId: configId,
      requestMetadata: { courseId: ctx.courseId, ...metadata },
    }),
  ).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("auditConfigChange", err.cause))));
}
