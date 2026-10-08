---
type: Fact
title: "TypeScript 7 in apps, 5.9 in infra; stale node_modules breaks typecheck"
description: "apps/web, apps/admin, packages/ui and evals use typescript ^7 (native, tsc -b in ~3s); infra uses ^5.9 with plain tsc; a stale local install (missing @aws-sdk/client-s3) fails typecheck with TS2307 until npm ci."
tags: [typescript, npm, tooling, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:08:08Z" }
status: stable
governance: context
code_refs: [apps/web/package.json, infra/package.json, apps/web/tsconfig.json, apps/web/tsconfig.node.json, apps/web/tsconfig.worker.json, package-lock.json, .nvmrc]
sources:
  - resource: apps/web/package.json
  - resource: infra/package.json
  - resource: apps/web/tsconfig.worker.json
---

**Compilers.** Every app workspace and packages/ui/evals declare `"typescript": "^7.0.0"` and typecheck with `tsc -b` (project references). infra declares `"typescript": "^5.9.3"` and runs `tsc --noEmit` for typecheck and `tsc` (emit to `infra/dist`) for build, because Pulumi runs the compiled JS (`infra/dist/validate-production-inputs.js` is invoked directly by release.yml). Don't "align" them without checking Pulumi compatibility.

**apps/web project layout.** `tsconfig.json` covers `src/client` (DOM, `noEmit`, `vite/client` types) and references `tsconfig.node.json` (vite/drizzle/vitest configs, emits to `dist/.tsbuildinfo-node`) and `tsconfig.worker.json` (server, node, runtime, shared, db, lib, scripts; `types: ["node"]`; emits declarations to `dist/.tsbuildinfo-worker`). Server-side code is typechecked by `tsconfig.worker.json` despite the name. `noUnusedLocals`/`noUnusedParameters` are on.

**Stale install trap (observed).** In the working tree used for this survey, `npm run typecheck` failed with 18 errors (`TS2307: Cannot find module '@aws-sdk/client-s3'` in `src/server/storage/objectStore.ts`, `scripts/recover-knowledge.ts`, plus knock-on `TS7006`/`TS2339`). `npm ls @aws-sdk/client-s3` was empty although apps/web/package.json declares it. A fresh `npm ci` of the same commit typechecked cleanly. If typecheck reports missing modules that package.json lists, run `npm ci` (or `npm install`) before touching code.

**npm 11 install-script gating.** With npm 11.19, `npm ci` prints "8 packages have install scripts not yet covered by allowScripts" (esbuild, fsevents, protobufjs). Typecheck, tests, Vite dev and drizzle-kit all worked regardless on darwin-arm64 because platform binaries come from optional deps. The `packageManager` field says npm@10; CI uses whatever `actions/setup-node` ships for Node 24.

**Node.** `.nvmrc` is `24`; root `engines.node` is `>=24`; the runtime image is `node:24-bookworm-slim` pinned by digest.

## Incremental tsc -b can pass stale (2026-10-08)

`npm run typecheck` (turbo -> `tsc -b`) reuses `.tsbuildinfo`. After changing a repository function's signature, it reported 0 errors while `tsc -b --force` found 51 broken call sites. When a change alters a shared signature, verify with `npx turbo typecheck --force` (or `npx tsc -b --force` in the workspace) before trusting a green typecheck. CI starts from a cold cache, so it catches this; a local claim of done should not depend on CI to.
