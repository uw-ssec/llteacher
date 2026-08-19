import { createOpenAI } from "@ai-sdk/openai";

export function getOpenRouter(apiKey: string) {
  return createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://llteacher.uw.edu",
      "X-Title": "LLteacher",
    },
  });
}

/** The gateway's default base URL, used when `LLMOXIE_BASE_URL` is unset.
 *
 *  Kept as the default rather than a required binding so no existing
 *  deployment or `.dev.vars` breaks by omission -- but overridable, which it
 *  previously was not. Two reasons that matters. The host is an Azure
 *  Container Apps *generated* name (`lemonmoss-19296c81` is the environment
 *  suffix), so it does not survive the environment being recreated, and
 *  recovering from that would otherwise need a code change and a redeploy
 *  rather than a config change. And it is explicitly the `-prod` deployment,
 *  so before this every local dev and preview worker configured for llmoxie
 *  sent student traffic to production. */
export const LLMOXIE_DEFAULT_BASE_URL =
  "https://llmaven-prod-litellm-prod.lemonmoss-19296c81.westus2.azurecontainerapps.io/v1";

/** #178: LLMoxie, UW SSEC's AI gateway -- a LiteLLM proxy deployment
 *  (confirmed by its own hostname), which exposes the same OpenAI-compatible
 *  REST surface OpenRouter does. createOpenAI works against any such
 *  surface; only the base URL and key differ from getOpenRouter above. */
export function getLLMoxie(apiKey: string, baseURL?: string) {
  return createOpenAI({
    apiKey,
    // LiteLLM's proxy serves its OpenAI-compatible surface under /v1, same
    // as getOpenRouter's own baseURL shape above.
    baseURL: baseURL || LLMOXIE_DEFAULT_BASE_URL,
  });
}
