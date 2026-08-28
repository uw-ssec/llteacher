/** The tool names the generative-UI registry can actually turn into
 *  something a student sees.
 *
 *  Plain TypeScript, deliberately -- no React import -- so the Cloudflare
 *  Worker in apps/web can import it too. Same pattern (and the same reason)
 *  as `@llteacher/ui/auth/courseRole`: one definition both sides read,
 *  rather than a hand-kept mirror that drifts.
 *
 *  Why it exists (final review of #307/#342). Not every tool in the
 *  server's catalog has a renderer. `requestHint` (#80) is a real,
 *  model-callable tool in section conversations that DELIBERATELY has none:
 *  its whole effect is server-side (a `hint_events` row, a budget check),
 *  and it has no display purpose -- see render.tsx's own comment saying so.
 *  But chat.ts's `hasRenderableContent` -- the gate deciding whether an
 *  assistant turn is real enough to persist and to replay on a retry --
 *  accepted ANY `tool-*` part in a resolved state (`output-available` /
 *  `output-error`), tool name unchecked. So a turn whose only content was a
 *  resolved `requestHint` call passed the gate, got persisted, and then
 *  `renderToolPart` returned `null` for it on every replay: a permanently
 *  blank assistant bubble that Retry could never fix, because the
 *  idempotency path saw a persisted row and treated it as "already
 *  answered."
 *
 *  So the gate needs to know what the CLIENT can draw, not merely what the
 *  server can call. This set is that answer, and `renderToolPart` itself is
 *  gated on it (below its own dispatch) so a name can never be renderable
 *  on one side of the boundary and not the other.
 *
 *  ADDING A TOOL: a tool belongs here only once a renderer for it exists in
 *  `render.tsx`. A side-effect-only tool (requestHint's shape) must stay
 *  out -- the model can still call it, its result still reaches the model,
 *  and a turn is simply not treated as "answered" on that call alone.
 *  `render.test.tsx` asserts the two stay in lockstep in both directions. */
export const RENDERABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "showDefinition",
  "executeRCode",
  "markSectionComplete",
]);

/** True when a `tool-<name>` part type names a tool the client can render.
 *  Takes the full part type (`"tool-showDefinition"`), not the bare name,
 *  because that is the shape both callers hold: the persisted part's
 *  `type` on the server, and `ToolPart["type"]` on the client. */
export function isRenderableToolPartType(partType: string): boolean {
  return partType.startsWith("tool-") && RENDERABLE_TOOL_NAMES.has(partType.slice("tool-".length));
}
