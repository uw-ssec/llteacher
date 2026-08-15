import type { Db } from "../../db/client";
import { llmCallLogs } from "../../db/schema";
import type { LlmProvider } from "../../lib/llm-config";

/* --------------------------------------------------------------------------
   #317 review, #321: llm_call_logs has existed since an earlier schema pass
   (id, message_id, conversation_id, organization_id, llm_config_id,
   provider, model, provider_request_id, input_tokens, output_tokens,
   cost_cents, latency_ms, error_flag, occurred_at) -- nothing in the repo
   ever wrote to it. A provider failure was previously invisible on the
   server: no error rate, no per-provider breakdown, no latency, no cost,
   the incident began with zero evidence. chat.ts calls recordLlmCallLog
   once per turn from its onFinish (success, aborted, and provider-error
   cases all reach it), including the error_flag: true case that used to
   early-return with nothing written anywhere.
   -------------------------------------------------------------------------- */

export interface LlmCallLogInput {
  messageId: string | null;
  conversationId: string;
  organizationId: string;
  llmConfigId: string;
  provider: LlmProvider;
  model: string;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  latencyMs: number;
  errorFlag: boolean;
}

/** Best-effort by design: called from chat.ts's onFinish, which has already
 *  streamed (or finished streaming) the response to the client -- a
 *  logging failure here must never surface as a second error layered on
 *  top of the turn's own outcome. Callers catch and log via
 *  logServerError themselves (matching every other onFinish sub-step in
 *  chat.ts), so this function itself stays a plain insert with no internal
 *  try/catch of its own. */
export async function recordLlmCallLog(db: Db, input: LlmCallLogInput): Promise<void> {
  await db.insert(llmCallLogs).values({
    messageId: input.messageId,
    conversationId: input.conversationId,
    organizationId: input.organizationId,
    llmConfigId: input.llmConfigId,
    provider: input.provider,
    model: input.model,
    providerRequestId: input.providerRequestId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costCents: input.costCents,
    latencyMs: input.latencyMs,
    errorFlag: input.errorFlag,
  });
}
