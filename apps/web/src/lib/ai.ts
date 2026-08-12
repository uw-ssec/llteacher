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

/** #178: LLMoxie, UW SSEC's AI gateway -- a LiteLLM proxy deployment
 *  (confirmed by its own hostname), which exposes the same OpenAI-compatible
 *  REST surface OpenRouter does. createOpenAI works against any such
 *  surface; only the base URL and key differ from getOpenRouter above. */
export function getLLMoxie(apiKey: string) {
  return createOpenAI({
    apiKey,
    // LiteLLM's proxy serves its OpenAI-compatible surface under /v1, same
    // as getOpenRouter's own baseURL shape above.
    baseURL: "https://llmaven-prod-litellm-prod.lemonmoss-19296c81.westus2.azurecontainerapps.io/v1",
  });
}
