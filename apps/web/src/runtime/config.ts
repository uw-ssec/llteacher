import { Effect } from "effect";
import { RuntimeConfigError } from "../server/effect/errors";

/** One variable's outcome: its value, or the problem an operator must fix. */
type Check<A> = { ok: true; value: A } | { ok: false; problem: string };

function required(env: NodeJS.ProcessEnv, name: string): Check<string> {
  const value = env[name];
  return value ? { ok: true, value } : { ok: false, problem: `${name} is required` };
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const check = required(env, "DATABASE_URL");
  if (!check.ok) throw new Error(check.problem);
  return check.value;
}

function appOrigin(env: NodeJS.ProcessEnv): Check<string> {
  const check = required(env, "APP_URL");
  if (!check.ok) return check;
  let url: URL;
  try {
    url = new URL(check.value);
  } catch {
    return { ok: false, problem: "APP_URL must be an absolute HTTP(S) origin" };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    return { ok: false, problem: "APP_URL must be an absolute HTTP(S) origin with no path, query, hash, or credentials" };
  }
  return { ok: true, value: url.origin };
}

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "LLMOXIE_API_KEY",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "BLIND_INDEX_KEY",
  "WORKOS_WEBHOOK_SECRET",
] as const;

/**
 * The runtime bindings as an Effect. Every required variable is checked
 * before failing, so a misconfigured deployment reports all of its
 * problems in one RuntimeConfigError instead of one per restart.
 */
export function runtimeConfig(env: NodeJS.ProcessEnv): Effect.Effect<Env, RuntimeConfigError> {
  return Effect.suspend(() => {
    const origin = appOrigin(env);
    const secrets = REQUIRED_SECRETS.map((name) => [name, required(env, name)] as const);
    const problems = [origin, ...secrets.map(([, check]) => check)]
      .flatMap((check) => (check.ok ? [] : [check.problem]));
    if (problems.length > 0 || !origin.ok) return Effect.fail(new RuntimeConfigError({ problems }));
    const value = Object.fromEntries(secrets.map(([name, check]) => [name, check.ok ? check.value : ""])) as
      Record<(typeof REQUIRED_SECRETS)[number], string>;
    return Effect.succeed({
      APP_URL: origin.value,
      AWS_REGION: env.AWS_REGION,
      DATABASE_URL: value.DATABASE_URL,
      WORKOS_API_KEY: value.WORKOS_API_KEY,
      WORKOS_CLIENT_ID: value.WORKOS_CLIENT_ID,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      LLMOXIE_API_KEY: value.LLMOXIE_API_KEY,
      LLMOXIE_BASE_URL: env.LLMOXIE_BASE_URL,
      LLM_DEGRADED_MODEL: env.LLM_DEGRADED_MODEL,
      SESSION_SECRET: value.SESSION_SECRET,
      ENCRYPTION_KEY: value.ENCRYPTION_KEY,
      BLIND_INDEX_KEY: value.BLIND_INDEX_KEY,
      WORKOS_WEBHOOK_SECRET: value.WORKOS_WEBHOOK_SECRET,
      // AWS uses the SDK task-role credential chain. Local storage uses an
      // endpoint and explicit emulator credentials.
      STORAGE_ENDPOINT: env.STORAGE_ENDPOINT,
      STORAGE_BUCKET: env.STORAGE_BUCKET,
      STORAGE_ACCESS_KEY_ID: env.STORAGE_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: env.STORAGE_SECRET_ACCESS_KEY,
      KNOWLEDGE_ROOT: env.KNOWLEDGE_ROOT,
      OKF_BINARY: env.OKF_BINARY,
      OCR_MODEL: env.OCR_MODEL,
    });
  });
}

/**
 * Converts the Node process environment into the bindings consumed by the
 * Hono application. Static assets are served by the Node entry point, so
 * Worker-only bindings are intentionally not carried into this object.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): Env {
  return Effect.runSync(runtimeConfig(env).pipe(
    Effect.catchTag("RuntimeConfigError", (error) => Effect.die(new Error(error.message))),
  ));
}
