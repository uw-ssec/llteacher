---
type: Fact
title: "Node 26's built-in localStorage breaks App.test.tsx under jsdom"
description: "On Node 26 the experimental global localStorage (a stub without --localstorage-file) shadows jsdom's, so 13 App.test.tsx tests fail with localStorage.clear is not a function; pre-existing, not a regression; CI uses Node 24; NODE_OPTIONS=--no-experimental-webstorage restores it locally."
tags: [testing, node, vitest, jsdom, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T18:32:07Z" }
status: stable
governance: context
code_refs: ["apps/web/src/client/App.test.tsx", ".nvmrc"]
sources:
  - resource: "PR #478"
  - resource: "local run, Node v26.7.0, 2026-10-08"
  - resource: "local run with --no-experimental-webstorage, Node v26.7.0, 2026-10-09"
---

On Node 26 (verified on v26.7.0, 2026-10-08), `apps/web/src/client/App.test.tsx` has 13 failing tests with `window.localStorage.clear is not a function`. Node 26 ships an experimental global `localStorage`. Without `--localstorage-file` it is a stub, and Node warns: "localStorage is not available because --localstorage-file was not provided". That stub overrides jsdom's Storage in the test environment. The failures also happen on `staging` before PR #478 and have nothing to do with it. Node 24, the version CI and the production image use, does not hit this.

How to apply: if these 13 tests fail locally on Node 26, they are not a regression from your change. Run the client tests on Node 24 to get a clean signal. Do not "fix" them by deleting or skipping the assertions.

Verified 2026-10-09: running the suite with `NODE_OPTIONS=--no-experimental-webstorage` on Node 26 brings jsdom's localStorage back, and all 75 `App.test.tsx` tests pass (`NODE_OPTIONS=--no-experimental-webstorage npx turbo run test`). Switching to Node 24 also works.

# Related Concepts
- [TypeScript 7 in apps, 5.9 in infra; stale node_modules breaks typecheck](code-typescript-and-install.md): Both are local-toolchain causes of failures that are not regressions.
