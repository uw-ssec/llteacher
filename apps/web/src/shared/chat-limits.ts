/* --------------------------------------------------------------------------
   Bounds on a chat turn that more than one module has to agree on.

   Separate from shared/types.ts because that module is types-only -- every
   one of its imports is `import type` and erases, so it costs the client
   bundle nothing. These are runtime values, and the point of them living
   here is that a number one module enforces and another describes or
   reserves against must be ONE number, not two that happen to match today
   (#288). Two such pairs live here: MAX_HISTORY_MESSAGES (the server
   enforces it, the client discloses it) and MAX_TURN_STEPS (the route
   enforces it, lib/context-window.ts reserves window space for it). This
   module imports nothing, so either side can depend on it.
   -------------------------------------------------------------------------- */

/** How many trailing messages of a conversation the model actually sees on
 *  a given turn. Enforced in server/routes/chat.ts; disclosed to the student
 *  by ConversationView's context-boundary divider.
 *
 *  #288: the client used to render the full fetched history with nothing
 *  marking this line, so a student could scroll up, read turn 3, reference
 *  it, and get an answer as if it had never happened -- indistinguishable
 *  from the tutor simply being obtuse. chat.ts's own comment called the
 *  silent drop "a graceful degradation (the student can still reference
 *  them in the visible UI transcript)", and that parenthetical was exactly
 *  the bug: the student can reference them and the tutor cannot see them.
 *
 *  A token-budget window would be more correct than a message count -- 40
 *  messages of pasted data still overflows a context -- so #88 added one:
 *  lib/context-window.ts, applied server-side on top of this count. The two
 *  compose in one direction only, and that ordering is what keeps this
 *  constant honest as the number the client discloses. This count is the
 *  OUTER bound (it is what the DB read is sized to); the token budget can
 *  only ever drop MORE. So a message above the divider is certainly not seen
 *  by the model, which is exactly what the divider claims -- the residual gap
 *  is that on a pathologically large conversation a few messages just BELOW
 *  the divider may also have been dropped. #288's own text anticipates this
 *  ("worth fixing regardless of which bound is used"): under-promising which
 *  turns survived is the safe direction for a disclosure to be wrong in. */
export const MAX_HISTORY_MESSAGES = 40;

/** How many model steps ONE turn may run. Passed to streamText as
 *  `stopWhen: stepCountIs(MAX_TURN_STEPS)` in server/routes/chat.ts, so the
 *  model can call a display tool and then continue with the follow-up
 *  Socratic question in the same turn -- without it, streamText stops the
 *  moment a tool call is emitted.
 *
 *  Shared rather than a literal at that one call site because it is also a
 *  BUDGET input. Each step generates its own completion (assistant text
 *  and/or tool calls), and every completed step's output is part of the
 *  context the NEXT step is sent -- so one turn's worst-case generation cost
 *  against the window is `max_completion_tokens` times this number, not
 *  once. lib/context-window.ts's resolveHistoryTokenBudget reserves on that
 *  basis; if this number ever changes, the reservation has to change with
 *  it, and two copies of a 5 in two files is exactly how it wouldn't. */
export const MAX_TURN_STEPS = 5;
