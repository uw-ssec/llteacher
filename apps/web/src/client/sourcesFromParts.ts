import type { SourceRef } from "@llteacher/ui";

export function sourcesFromParts(parts: unknown): SourceRef[] {
  if (!Array.isArray(parts)) return [];
  const seen = new Map<string, string>();
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; state?: unknown; output?: unknown };
    if (p.type !== "tool-showKnowledge" || p.state !== "output-available") continue;
    const out = p.output as { conceptId?: unknown; title?: unknown } | undefined;
    if (typeof out?.conceptId !== "string" || typeof out.title !== "string") continue;
    if (!seen.has(out.conceptId)) seen.set(out.conceptId, out.title);
  }
  return [...seen].map(([conceptId, title]) => ({ conceptId, title }));
}
