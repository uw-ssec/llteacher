function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return requireValue(env, "DATABASE_URL");
}

function requireAppOrigin(env: NodeJS.ProcessEnv): string {
  const value = requireValue(env, "APP_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL must be an absolute HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("APP_URL must be an absolute HTTP(S) origin with no path, query, hash, or credentials");
  }
  return url.origin;
}

/**
 * Converts the Node process environment into the bindings consumed by the
 * Hono application. Static assets are served by the Node entry point, so
 * Worker-only bindings are intentionally not carried into this object.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): Env {
  return {
    APP_URL: requireAppOrigin(env),
    DATABASE_URL: loadDatabaseUrl(env),
    WORKOS_API_KEY: requireValue(env, "WORKOS_API_KEY"),
    WORKOS_CLIENT_ID: requireValue(env, "WORKOS_CLIENT_ID"),
    OPENROUTER_API_KEY: requireValue(env, "OPENROUTER_API_KEY"),
    LLMOXIE_API_KEY: requireValue(env, "LLMOXIE_API_KEY"),
    LLMOXIE_BASE_URL: env.LLMOXIE_BASE_URL,
    LLM_DEGRADED_MODEL: env.LLM_DEGRADED_MODEL,
    SESSION_SECRET: requireValue(env, "SESSION_SECRET"),
    ENCRYPTION_KEY: requireValue(env, "ENCRYPTION_KEY"),
    BLIND_INDEX_KEY: requireValue(env, "BLIND_INDEX_KEY"),
    WORKOS_WEBHOOK_SECRET: requireValue(env, "WORKOS_WEBHOOK_SECRET"),
    // The knowledge base (#42): uploads land in S3-compatible storage and the
    // OKF bundle lives under KNOWLEDGE_ROOT (EFS in production). All optional
    // here so a stack that has not provisioned them yet (#81) still starts;
    // the storage and knowledge factories refuse clearly when asked for.
    STORAGE_ENDPOINT: env.STORAGE_ENDPOINT,
    STORAGE_BUCKET: env.STORAGE_BUCKET,
    STORAGE_ACCESS_KEY_ID: env.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: env.STORAGE_SECRET_ACCESS_KEY,
    KNOWLEDGE_ROOT: env.KNOWLEDGE_ROOT,
    OKF_BINARY: env.OKF_BINARY,
    OCR_MODEL: env.OCR_MODEL,
  };
}
