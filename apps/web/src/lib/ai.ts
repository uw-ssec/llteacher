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
