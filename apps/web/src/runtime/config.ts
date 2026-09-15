function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return databaseUrl;
}

/**
 * Converts the Node process environment into the bindings consumed by the
 * Hono application. Static assets are served by the Node entry point, so
 * Worker-only bindings are intentionally not carried into this object.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): Env {
  return {
    DATABASE_URL: requireDatabaseUrl(env),
    WORKOS_API_KEY: env.WORKOS_API_KEY ?? "",
    WORKOS_CLIENT_ID: env.WORKOS_CLIENT_ID ?? "",
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? "",
    LLMOXIE_API_KEY: env.LLMOXIE_API_KEY ?? "",
    LLMOXIE_BASE_URL: env.LLMOXIE_BASE_URL,
    LLM_DEGRADED_MODEL: env.LLM_DEGRADED_MODEL,
    SESSION_SECRET: env.SESSION_SECRET ?? "",
    ENCRYPTION_KEY: env.ENCRYPTION_KEY ?? "",
    BLIND_INDEX_KEY: env.BLIND_INDEX_KEY ?? "",
    WORKOS_WEBHOOK_SECRET: env.WORKOS_WEBHOOK_SECRET ?? "",
  };
}
