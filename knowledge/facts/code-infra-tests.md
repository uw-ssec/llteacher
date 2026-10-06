---
type: Fact
title: "Infra tests: vitest + node:test in npm test; *.test.sh are manual"
description: "npm test in infra runs vitest (src/**/*.test.ts) then node --test scripts/*.test.mjs; the 13 scripts/*.test.sh stub pulumi/docker/aws on PATH and are not in npm test or CI (docker-image-aws.test.sh needs a Docker daemon)."
tags: [infra, testing, shell, pulumi]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["infra/package.json", "infra/vitest.config.ts", "infra/src/resources.test.ts", "infra/scripts", "infra/scripts/release-workflow.test.mjs", "infra/scripts/local-up.test.sh", "infra/scripts/run-local-migrations.test.sh"]
sources:
  - resource: "infra/package.json"
  - resource: "infra/vitest.config.ts"
  - resource: "package.json"
---

**What `npm test --workspace=infra` runs** (also part of root `npm test` via turbo): `vitest run && node --test scripts/*.test.mjs`.
- vitest includes only `src/**/*.test.ts`: `config.test.ts`, `deployment-inputs.test.ts`, `dns.test.ts`, `resources.test.ts` (Pulumi resource graph with mocks: IAM boundaries, secret policies, task-role grants). 59 tests, ~12s.
- `node --test scripts/*.test.mjs`: `account-bootstrap`, `aws-release`, `bootstrap-policy`, `release-image-smoke`, `release-workflow` tests. These parse `.github/workflows/release.yml` and the shell helpers and assert security properties (secrets never in args/outputs/artifacts, OIDC only on the tag job, image identity checks, all workflow shell steps parse under bash). 99 tests, 1 skipped, ~42s (the validator CLI test alone ~16s).
No AWS credentials, Pulumi CLI or Docker are needed for either.

**Changing release.yml or infra/scripts/*.sh will often break `release-workflow.test.mjs`/`aws-release.test.mjs`.** They encode reviewed invariants; update tests deliberately, not by loosening assertions.

**Shell tests (`infra/scripts/*.test.sh`, 13 files).** Each copies the script under test into a `mktemp -d` tree and stubs `pulumi`, `docker`, `aws`, `curl` on PATH, logging calls and asserting order. Not wired into `npm test` or CI; run individually:

```bash
for t in infra/scripts/*.test.sh; do bash "$t" || echo "FAIL $t"; done
```

Result at HEAD (macOS, no Docker daemon): 12 pass in 0-3s each; `docker-image-aws.test.sh` fails because it needs a real Docker daemon. `npm run aws:local:migration-guard` is just `run-local-migrations.test.sh`.

macOS has no `timeout` binary; scripts that use it (`run-aws-migrations.sh`) guard with `command -v timeout`.

**Typecheck:** `tsc --noEmit` (TS 5.9). turbo warns "no output files found for task infra#typecheck/test"; harmless.
