---
type: Fact
title: turbo typecheck race between evals and web
description: "llteacher-evals#typecheck is overridden in turbo.json to depend on llteacher-web#typecheck because both tsc -b runs write apps/web/dist/.tsbuildinfo-worker; overrides must redeclare the whole task."
tags: [turbo, typecheck, gotcha, evals]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:33:36Z" }
status: stable
governance: constraint
code_refs: [turbo.json, evals/tsconfig.json, apps/web/tsconfig.worker.json]
sources:
  - resource: turbo.json
  - resource: evals/tsconfig.json
  - resource: 9743dd7
---

`evals/tsconfig.json` project-references `apps/web/tsconfig.worker.json`, whose `outDir` is `apps/web/dist/.tsbuildinfo-worker`. `llteacher-web`'s own `tsc -b` builds the same reference. `llteacher-evals` has no package.json dependency on `llteacher-web` (it imports `apps/web/src/lib/{prompts,ai}.ts` by relative path), so turbo's dependency graph has no edge between them and would run both `tsc -b` processes in parallel. From a cold cache (every CI run; test.yml restores no `dist/`), two processes would race to write the same tsbuildinfo directory, which `tsc -b` is not built to survive.

The fix is the package-specific task in turbo.json:

```jsonc
"llteacher-evals#typecheck": {
  "dependsOn": ["^build", "llteacher-web#typecheck"],
  "outputs": ["*.tsbuildinfo", "dist/.tsbuildinfo-*/**"]
}
```

Rules that follow:

- **Turbo does not deep-merge** a `pkg#task` override with the generic `typecheck` task. Redeclare every field (dependsOn, outputs) when editing either one.
- **Any new workspace that project-references another workspace's tsconfig** without a package.json dependency needs the same explicit edge.
- **turbo.json uses JSONC comments.** Turbo accepts them; generic JSON tooling (jq, python json) does not. Edit by hand.
- The generic `typecheck` task's `dependsOn: ["^build"]` only builds upstream workspace deps, never the package itself. `npm run typecheck` does not prove the Vite bundles build; CI runs `npm run build` separately.

Measured: `npm run typecheck` on a clean `npm ci` checkout passes 5/5 tasks in about 3.4s wall time (TS 7 native compiler). turbo warns "no output files found for task infra#typecheck"; that warning is harmless (`tsc --noEmit`).
