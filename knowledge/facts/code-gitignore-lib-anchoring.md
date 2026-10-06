---
type: Fact
title: .gitignore lib/ must stay root-anchored
description: "Root .gitignore anchors the Python template's lib/ and lib64/ to /lib/ because unanchored they silently ignored TS source dirs like packages/ui/src/lib; un-ignore rules for apps/*/src/lib also exist."
tags: [git, gitignore, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: [".gitignore", "packages/ui/src/lib", "apps/web/src/lib", "apps/admin/src/client/lib", "apps/web/.gitignore"]
sources:
  - resource: ".gitignore"
  - resource: "ac34e17"
  - resource: "a7cf2c3"
---

The root `.gitignore` began as the standard Python template, which has unanchored `lib/` and `lib64/`. Unanchored, those match ANY directory named `lib` at any depth. That silently swallowed new TypeScript source under `packages/ui/src/lib`: the files existed locally, tests passed locally, but they were never committed. They would also have hidden `apps/web/src/lib` and `apps/admin/src/client/lib` if those had not predated the rule.

Current state (committed): `/lib/` and `/lib64/` are anchored to the repo root, with a comment explaining why. A second block also un-ignores `apps/web/src/lib/`, `apps/admin/src/lib/` and `apps/admin/src/client/lib/` (with `/**`) from the earlier fix.

Rules:

- **Never reintroduce an unanchored generic directory pattern** (`lib/`, `build/`, `dist/`, `var/`, `parts/`) at the root. Python virtualenv contents are already covered by `.venv/`, `venv/`, `env/`, `ENV/`.
- **When adding a new source directory with a generic name, verify it is tracked:** `git check-ignore -v <path>` should print nothing, and `git status` should list new files.
- Workspace-local ignores live in `apps/web/.gitignore`: `dist/`, `.dev.vars`, `.wrangler/`, `*.config.js` (tsc emits `vite.config.js`, `drizzle.config.js`, `.d.ts` siblings from `tsconfig.node.json`; they are ignored artifacts, edit the `.ts`), and `src/client/public/webr/` (copied from node_modules by `copy-webr-assets` on predev/prebuild).
- Also ignored at root: `/evals/results/latest.json` (eval output), `.floci/`, `.pulumi/`, `infra/Pulumi.local.yaml` (local AWS state).

Note: `.gitignore` may have uncommitted edits in a working tree (for example agent-config rules); check `git diff .gitignore` before assuming the committed state.
