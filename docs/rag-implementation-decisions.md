# RAG implementation decisions (epic #44)

1. **Embedding model and dimension.** None this quarter. Retrieval is lexical (okf's BM25 over the course bundle).
   `material_chunks` keeps its 1536-dim column for a future hybrid leg; nothing writes it. Adding embeddings later is a
   second ranking leg behind `KnowledgeService.search`, not a schema change.
2. **Retrieval strategy.** Model-driven search and show tools (okf's progressive disclosure), not pre-turn top-k injection.
   The system prompt carries the bundle's table of contents; the model searches from there. Deferred: hybrid, reranking.
3. **Chunking parameters.** None. Concepts are whole documents; `showKnowledge` returns up to 12,000 characters.
   Long documents are split by the instructor or by the deferred agent-refinement tier, not by a window.
4. **Grounding scope.** Course-wide bundle. Collections and per-assignment attachment exist in the schema and console
   code but are unregistered this quarter (spec 2026-09-15, "Rejected alternatives").
5. **Citation span tracking.** Not used. A citation is a concept the model opened; `concept_path` and `concept_title`
   are recorded, `span_start`/`span_end` stay null.
6. **Eval set maintenance.** Deferred with #43. The manual protocol in `docs/rag-smoke-test.md` is the regression check
   until the harness exists; its step-8 table is the seed for the first eval set.
