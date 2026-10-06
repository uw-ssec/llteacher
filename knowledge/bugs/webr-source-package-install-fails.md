---
type: Bug
title: WebR install.packages silently failed; tidyverse never loaded
description: "WebR's R runtime cannot build source packages, so install.packages for ggplot2/dplyr/tidyr failed and per-package catch hid it; fixed with webR.installPackages from the WASM binary repo."
tags: [webr, r-execution, frontend, security]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/client/hooks/useWebR.ts", "apps/web/src/client/hooks/useWebR.test.ts", "apps/web/src/client/public/webr", "apps/web/scripts/copy-webr-assets.mjs"]
sources:
  - resource: "issue #374"
  - resource: "PR #379"
  - resource: "issue #369"
  - resource: "issue #375"
  - resource: "PR #366"
---

## Bug (#374, fixed in PR #379)

M4 PR3 (#366) added client-side R execution with WebR. `DEFAULT_PACKAGES` (ggplot2, dplyr, tidyr) were installed by evaluating R's own `install.packages()`, which fails inside WebR:

```
This version of R is not set up to install source packages
```

That is correct behaviour, not a misconfiguration: there is no C/C++/Fortran toolchain inside the WASM R process. The install loop caught each failure per package, so R execution shipped with none of the three packages and no warning. `library(dplyr)` simply errored for students.

**Fix:** `await webR.installPackages(DEFAULT_PACKAGES, { repos: WEBR_REPO_URL, quiet: true })`. This uses WebR's repository of packages precompiled to WASM, mounted as Emscripten filesystem images, in one call so the shared dependency graph resolves once. `WEBR_REPO_URL` stays at `https://repo.r-wasm.org` because the mirror is too big to vendor. It sends `access-control-allow-origin: *`, which the app's `require-corp` COEP header needs.

## Related security lesson (#369)

The first WebR port loaded `https://webr.r-wasm.org/latest/webr.mjs` with a dynamic `import()`. That ran unpinned third-party JavaScript in the authenticated origin, which holds education records, with no CSP. Now the WebR runtime is self-hosted under `apps/web/src/client/public/webr` and copied by `copy-webr-assets.mjs`. R packages fetched as data and run inside the WASM sandbox are a different risk class from JavaScript, which is why the package repo can stay remote. A baseline CSP is still open (#375).

## Lesson

Per-item try/catch in setup loops hides total failure. Assert the post-condition, for example `requireNamespace("dplyr")`, and surface it.
