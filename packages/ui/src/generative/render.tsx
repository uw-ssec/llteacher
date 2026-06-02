/* --------------------------------------------------------------------------
   Generative-UI tool renderer registry.

   Maps a UIMessage tool part (`{ type: 'tool-<toolName>', input, state }`)
   to a React node. Returns `null` for tools we don't know about so the
   conversation degrades gracefully when the server's tool catalog grows
   ahead of the client.

   Adding a new tool:
     1. Define the input schema on the server in routes/chat.ts
     2. Build the component in packages/ui/src/generative/
     3. Add a case here
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";
import { DefinitionCard } from "./DefinitionCard";

/* The minimal shape of a tool part we care about. AI SDK v5 emits parts
   with `type: 'tool-<toolName>'` and a state machine on `state`. */
export interface ToolPart {
  type: string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: unknown;
}

export function renderToolPart(part: ToolPart, key: string): ReactNode {
  /* Temporary diagnostic — logs every tool-* part the registry sees so we
     can tell whether the model is calling the tool at all, and what state
     the part is in. Remove once the demo is stable. */
  if (
    typeof window !== "undefined" &&
    typeof part.type === "string" &&
    part.type.startsWith("tool-")
  ) {
    // eslint-disable-next-line no-console
    console.log("[generative-ui] tool part:", {
      type: part.type,
      state: part.state,
      input: part.input,
    });
  }

  if (part.type === "tool-showDefinition") {
    const input = (part.input ?? {}) as Partial<{ term: string; body: string }>;
    /* Don't render anything until we have at least a term to anchor the card */
    if (!input.term) return null;
    return (
      <DefinitionCard
        key={key}
        term={input.term ?? ""}
        body={input.body ?? ""}
        isPartial={part.state === "input-streaming"}
      />
    );
  }
  return null;
}
