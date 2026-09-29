import * as pulumi from "@pulumi/pulumi";
import type { Environment } from "./config.js";

export const RUNTIME_SECRET_NAMES = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_WEBHOOK_SECRET",
  "OPENROUTER_API_KEY",
  "LLMOXIE_API_KEY",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "BLIND_INDEX_KEY",
] as const;

type RuntimeSecretName = (typeof RUNTIME_SECRET_NAMES)[number];

export interface PlainProductionDeploymentInputs {
  databasePassword: string;
  runtimeSecrets: Record<RuntimeSecretName, string>;
  llmoxieBaseUrl: string;
}

export interface DeploymentInputs {
  databasePassword: pulumi.Output<string>;
  runtimeSecretValue: pulumi.Output<string>;
  llmoxieBaseUrl?: string;
}

function invalid(name: string, explanation: string): never {
  throw new Error(`${name}: ${explanation}`);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) invalid(name, "a non-empty value is required.");
  if (value !== value.trim()) invalid(name, "surrounding whitespace is not allowed.");
  if (/[\x00-\x20\x7f]/.test(value)) invalid(name, "ASCII whitespace or control characters are not allowed.");
  return value;
}

function requireCanonicalKey(name: RuntimeSecretName, value: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    invalid(name, "must be canonical standard base64 encoding of 32 bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    invalid(name, "must be canonical standard base64 encoding of 32 bytes.");
  }
}

function requireLlmoxieUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("LLMOXIE_BASE_URL", "must be an absolute HTTPS URL ending in /v1.");
  }
  const authority = /^https:\/\/([^/\\?#]+)(?:\/|$)/.exec(value)?.[1];
  if (
    !authority ||
    url.protocol !== "https:" ||
    !url.hostname ||
    authority.includes("@") ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    !url.pathname.endsWith("/v1")
  ) {
    invalid("LLMOXIE_BASE_URL", "must be an absolute HTTPS URL ending in /v1 without credentials, query, or fragment.");
  }
}

export function parseProductionDeploymentEnvironment(
  env: Record<string, string | undefined>,
): PlainProductionDeploymentInputs {
  const databasePassword = required(env, "DATABASE_PASSWORD");
  if (
    databasePassword.length < 8 ||
    databasePassword.length > 128 ||
    !/^[\x21-\x7e]+$/.test(databasePassword) ||
    /[/'"@]/.test(databasePassword)
  ) {
    invalid("DATABASE_PASSWORD", "must be 8–128 printable ASCII characters without /, quotes, @, or spaces.");
  }

  const runtimeSecrets = {} as Record<RuntimeSecretName, string>;
  for (const name of RUNTIME_SECRET_NAMES) {
    runtimeSecrets[name] = required(env, name);
  }

  for (const [name, prefix] of [
    ["WORKOS_API_KEY", "sk_"],
    ["WORKOS_CLIENT_ID", "client_"],
    ["OPENROUTER_API_KEY", "sk-or-"],
  ] as const) {
    if (!runtimeSecrets[name].startsWith(prefix)) {
      invalid(name, "has an invalid provider credential prefix.");
    }
  }

  const keyNames = ["SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"] as const;
  const seenKeys = new Set<string>();
  for (const name of keyNames) {
    const value = runtimeSecrets[name];
    requireCanonicalKey(name, value);
    if (seenKeys.has(value)) invalid(name, "must differ from the other application keys.");
    seenKeys.add(value);
  }

  const llmoxieBaseUrl = required(env, "LLMOXIE_BASE_URL");
  requireLlmoxieUrl(llmoxieBaseUrl);

  return { databasePassword, runtimeSecrets, llmoxieBaseUrl };
}

export function loadDeploymentInputs(
  environment: Environment,
  config?: pulumi.Config,
  env: Record<string, string | undefined> = process.env,
): DeploymentInputs {
  if (environment === "production") {
    const parsed = parseProductionDeploymentEnvironment(env);
    return {
      databasePassword: pulumi.secret(parsed.databasePassword),
      runtimeSecretValue: pulumi.secret(JSON.stringify(parsed.runtimeSecrets)),
      llmoxieBaseUrl: parsed.llmoxieBaseUrl,
    };
  }

  const localConfig = config ?? new pulumi.Config();
  return {
    databasePassword: localConfig.requireSecret("databasePassword"),
    runtimeSecretValue: localConfig.requireSecret("runtimeSecrets"),
  };
}
