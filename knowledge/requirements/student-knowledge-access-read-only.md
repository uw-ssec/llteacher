---
type: Requirement
title: "Students get read-only knowledge tools, scoped to their own course, and material is treated as untrusted"
description: "Students reach the knowledge base only via searchKnowledge/showKnowledge, course forced from their conversation; all write ops are instructor-of-course routes; uploaded content is data, never instructions."
tags: [knowledge, security, prompt-injection, tenancy]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/routes/chat.ts", "apps/web/src/server/knowledge/service.ts", "apps/web/src/server/knowledge/conceptId.ts", "apps/web/src/server/routes/knowledgeDocuments.ts", "apps/web/src/lib/prompts.ts", "apps/web/src/server/utils/guards.ts"]
sources:
  - resource: "docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md"
  - resource: "docs/rag-implementation-decisions.md"
  - resource: "commit b4eac8f"
  - resource: "commit cbeef4a"
---

## The requirement (OKF spec "Tenancy and security", plus later additions)
1. **Two read-only student tools.** `searchKnowledge {query, limit?}` and `showKnowledge {conceptId}` are offered only when the bundle is non-empty and the LLM config's knowledge switch is on. `create`, `update`, `relate`, `remove`, `rename`, `validate`, and instructor search are reachable only through `requireInstructorOf`-guarded console routes.
2. **Scope is forced.** The course id comes from the conversation the student can already access (`experimental_context`), never from tool arguments or the request body.
3. **Paths are derived and validated.** The course id is validated as a UUID before being joined into a path. Concept ids pass the OKF alphabet check (lowercase, digits, hyphen, slash; no `.`/`..`; no leading slash) and must resolve under the bundle root. The root passed to okf is a `realpath`. `index.md` and `log.md` are reserved.
4. **Process safety.** okf runs via `execFile` with an argument array, never a shell string. There is a 10 s timeout and a 4 MB stdout cap. Search returns at most 20 hits (default 8). Concept bodies sent to the model are capped at 12,000 characters with a truncation marker. Large bodies are written atomically, not passed through process arguments.
5. **Untrusted content.** Concept bodies are instructor-uploaded text, returned as data. A fixed guard sentence always follows the knowledge instruction (commit `b4eac8f`).
6. **Citations** record concepts the model *opened*, not search hits.
7. **Empty bundle:** no tools, no listing, no empty context block (#41 rule).

## Checks
- Cross-course isolation test: the same concept id in two courses. Course A's conversation sees only A's concept and gets `not_found` for B-only ids.
- Tool tests assert that scope comes from context and that body truncation works.

## Known gap
The live ten-question grounding evaluation and second-course browser isolation test listed in the 2026-09-16 OKF review were not completed then. Automated route and service tests cover authorization.
