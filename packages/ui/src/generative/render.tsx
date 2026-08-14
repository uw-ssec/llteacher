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

/** Runtime-validates the untrusted `input` of a `tool-showDefinition` part
 *  against the shape `DefinitionCard` expects. `part.input` is model-
 *  generated JSON -- an LLM can (and, per #144, routinely does) emit `term`
 *  as an object or `body` as an array. A raw cast (`as Partial<{ term:
 *  string; body: string }>`, the pre-#144 code here) lets that malformed
 *  shape flow straight into `<DefinitionCard term={term}>` as a JSX child,
 *  where React throws "Objects are not valid as a React child" during
 *  render -- taking down the whole app if nothing catches it.
 *
 *  Mirrors `parseCourseRole`'s deny-by-default pattern (packages/ui/src/
 *  auth/courseRole.ts): every field is checked against its expected runtime
 *  type, and the whole input is rejected (`null`) rather than partially
 *  trusted or coerced the moment anything doesn't match -- including a
 *  present-but-wrong-typed `body`, not just a missing one. Returns `null`
 *  (not a thrown error) both for "still streaming, no term yet" (the
 *  original short-circuit) and for "malformed", so callers keep the
 *  existing "nothing to show yet" behavior for both cases. */
export function parseShowDefinitionInput(
  value: unknown,
): { term: string; body: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { term, body } = value as Record<string, unknown>;
  if (term !== undefined && typeof term !== "string") return null;
  if (body !== undefined && typeof body !== "string") return null;
  /* Don't render anything until we have at least a term to anchor the card
     -- also covers "term omitted entirely" (still streaming its args). */
  if (typeof term !== "string" || term.length === 0) return null;
  return { term, body: typeof body === "string" ? body : "" };
}

/** Narrows an untrusted `UIMessage` part to `ToolPart` without a raw cast.
 *  `useChat()` here isn't given the server's tool-input generics, so
 *  TypeScript's `UIMessagePart` union can't statically prove `tool-*` parts
 *  carry `input`/`state` -- callers previously bridged that gap with `part
 *  as ToolPart`, which type-checks regardless of what the part actually is
 *  at runtime. This checks the one thing actually needed (a string `type`)
 *  before handing the part to `renderToolPart`, which then further
 *  validates the tool-specific `input` shape itself (see
 *  `parseShowDefinitionInput` above) rather than trusting either cast. */
export function isToolPart(part: unknown): part is ToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: unknown }).type === "string"
  );
}

export function renderToolPart(part: ToolPart, key: string): ReactNode {
  if (part.type === "tool-showDefinition") {
    const input = parseShowDefinitionInput(part.input);
    if (!input) return null;
    return (
      <DefinitionCard
        key={key}
        term={input.term}
        body={input.body}
        isPartial={part.state === "input-streaming"}
      />
    );
  }
  return null;
}
