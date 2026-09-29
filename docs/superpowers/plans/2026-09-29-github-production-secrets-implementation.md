# GitHub Production Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub's `production` environment the operator source of production secret values while Pulumi securely creates the AWS Secrets Manager resources consumed by ECS.

**Architecture:** A focused deployment-input module reads and validates the production process environment once, converts secret values into Pulumi secret outputs immediately, and supplies typed inputs to the resource graph. The release workflow maps GitHub secrets only into validation and Pulumi-update steps; Pulumi continues to own the runtime and derived database URL secrets used by ECS.

**Tech Stack:** TypeScript 5.9, Pulumi 3.262, `@pulumi/aws` 7.46, Vitest 2.1, GitHub Actions YAML, Node test runner, Bash.

**Spec:** `docs/superpowers/specs/2026-09-29-github-production-secrets-design.md`

## Global Constraints

- Production inputs are exactly nine GitHub environment secrets plus the non-secret `LLMOXIE_BASE_URL` environment variable named in the spec.
- GitHub remains the only place an operator edits values; AWS Secrets Manager is a Pulumi-generated runtime sink.
- No plaintext secret may enter Git, workflow logs, command-line arguments, `$GITHUB_ENV`, `$GITHUB_OUTPUT`, artifacts, Pulumi YAML, or ordinary ECS environment variables.
- Production secret values must become Pulumi secret outputs immediately after validation.
- Local and staging retain encrypted Pulumi configuration through `databasePassword` and `runtimeSecrets`.
- ECS continues using the execution role to retrieve the managed runtime and database URL secrets; the task role gets no Secrets Manager access.
- Secret changes take effect only through the next tagged release; do not add a standalone rotation workflow.
- Do not read real GitHub secret values, create a release tag, run a production preview/update, or mutate AWS while implementing this plan.
- Preserve the empty-stack `pulumi config refresh` guard from PR #466 when rebasing onto current `staging`.

## Review Focus

- Environment values containing whitespace or trailing newlines must fail rather than be silently normalized.
- Base64 strings that decode to 32 bytes but are non-canonical or URL-safe must fail with a redacted field-specific error.
- Secret error messages, test snapshots, and workflow output must never contain the rejected value.
- Every command that evaluates the production Pulumi program must receive the complete input set, while unrelated steps receive none of it.
- A first deployment with no prior stack checkpoint must retain the release workflow's empty-stack refresh behavior.

---

## Execution Preflight

- [ ] **Step 1: Rebase the isolated branch on current staging**

Run:

```bash
git fetch origin staging
git rebase origin/staging
```

Expected: the branch is based on current `origin/staging`; if conflicts occur, use `superpowers:resolving-merge-conflicts` and preserve both this design and PR #466's empty-stack refresh guard.

- [ ] **Step 2: Run the untouched baseline**

Run: `CI=true npm test`

Expected: PASS before implementation. Stop and diagnose any baseline failure rather than incorporating an unrelated fix.

### Task 1: Validated Deployment Input Boundary

**Files:**
- Create: `infra/src/deployment-inputs.ts`
- Create: `infra/src/deployment-inputs.test.ts`

**Interfaces:**
- Consumes: `Environment` from `infra/src/config.ts`, a `Record<string, string | undefined>` process-environment view, and an optional `pulumi.Config` for non-production compatibility.
- Produces: `RUNTIME_SECRET_NAMES`, `PlainProductionDeploymentInputs`, `DeploymentInputs`, `parseProductionDeploymentEnvironment(env)`, and `loadDeploymentInputs(environment, config?, env?)`.
- `DeploymentInputs` contains `databasePassword: pulumi.Output<string>`, `runtimeSecretValue: pulumi.Output<string>`, and `llmoxieBaseUrl?: string`.

- [ ] **Step 1: Write failing parser tests**

Add tests named:

- `accepts the complete production deployment environment`
- `rejects every missing or empty required setting without echoing its value`
- `rejects whitespace-padded values rather than normalizing credentials`
- `requires three distinct canonical base64 encodings of exactly 32 bytes`
- `enforces RDS PostgreSQL password constraints without echoing the password`
- `requires an HTTPS LLMoxie v1 URL without credentials query or fragment`
- `applies only provider-guaranteed credential prefixes`

Assert the accepted result separates `DATABASE_PASSWORD`, the exact eight-key runtime object in `RUNTIME_SECRET_NAMES` order, and `LLMOXIE_BASE_URL`. For every rejection, assert the message names the setting and does not contain the supplied value.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace=infra -- --run src/deployment-inputs.test.ts`

Expected: FAIL because `deployment-inputs.ts` does not exist.

- [ ] **Step 3: Implement the pure production parser**

Implement:

```ts
export function parseProductionDeploymentEnvironment(
  env: Record<string, string | undefined>,
): PlainProductionDeploymentInputs;
```

Use exact-name lookup without trimming. Require canonical RFC 4648 standard base64 for the three 32-byte keys, pairwise distinction, the RDS password rules from the spec, and an absolute HTTPS LLMoxie URL whose path ends in `/v1`. Prefix-check only WorkOS API keys (`sk_`), WorkOS client IDs (`client_`), and OpenRouter keys (`sk-or-`). Require WorkOS webhook and LLMoxie values merely to be non-empty because their issuers publish no stable prefix contract used by this repository.

- [ ] **Step 4: Implement the Pulumi-facing loader**

Implement:

```ts
export function loadDeploymentInputs(
  environment: Environment,
  config?: pulumi.Config,
  env?: Record<string, string | undefined>,
): DeploymentInputs;
```

For production, call the parser once, wrap the database password and serialized runtime object with `pulumi.secret`, and return the validated base URL as non-secret. For local and staging, call `config.requireSecret("databasePassword")` and `config.requireSecret("runtimeSecrets")`, returning no LLMoxie override.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
npm test --workspace=infra -- --run src/deployment-inputs.test.ts
npm run typecheck --workspace=infra
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add infra/src/deployment-inputs.ts infra/src/deployment-inputs.test.ts
git commit -m "feat(infra): validate production deployment secrets"
```

### Task 2: Pulumi Resource Graph Integration

**Files:**
- Modify: `infra/src/index.ts`
- Modify: `infra/src/database.ts`
- Modify: `infra/src/app.ts`
- Modify: `infra/src/resources.test.ts`

**Interfaces:**
- Consumes: `DeploymentInputs` and `loadDeploymentInputs` from Task 1.
- Produces: `createDataResources(name, config, network, provider, deploymentInputs)` and `createApplication(name, config, network, data, provider, deploymentInputs)`; existing exported stack outputs remain unchanged.

- [ ] **Step 1: Write failing resource-graph tests**

Update the mocked graph to supply explicit `DeploymentInputs`. Add assertions that:

- production creates one managed runtime `Secret` and `SecretVersion`;
- the runtime secret version contains exactly the eight deployment values and remains a Pulumi secret input;
- production RDS and derived URL use the supplied database password as secret inputs;
- `LLMOXIE_BASE_URL` appears once under ordinary ECS environment configuration;
- none of the nine secret values appears in ordinary ECS environment configuration;
- ECS secret entries still point to the managed runtime JSON keys and database URL ARN;
- local continues loading `databasePassword` and `runtimeSecrets` through Pulumi configuration and receives no production LLMoxie override.

- [ ] **Step 2: Run the resource tests and verify RED**

Run: `npm test --workspace=infra -- --run src/resources.test.ts`

Expected: FAIL because resource builders do not accept `DeploymentInputs` and do not inject `LLMOXIE_BASE_URL`.

- [ ] **Step 3: Load deployment inputs once at the program entrypoint**

In `infra/src/index.ts`, call `loadDeploymentInputs(config.environment)` after `loadInfraConfig()` and pass the returned object into both resource builders. Do not read `process.env` in `database.ts` or `app.ts`.

- [ ] **Step 4: Replace direct secret-config reads in the database module**

Change `createDataResources` to use `deploymentInputs.databasePassword` and `deploymentInputs.runtimeSecretValue`. Preserve the names, descriptions, protection behavior, derived URL format, and managed `Secret`/`SecretVersion` resources.

- [ ] **Step 5: Add the non-secret LLMoxie endpoint to the task definition**

Change `createApplication` to add `LLMOXIE_BASE_URL` to the container's ordinary environment list only when `deploymentInputs.llmoxieBaseUrl` is defined. Preserve all existing secret ARN injection and dependencies.

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
npm test --workspace=infra -- --run src/resources.test.ts
npm run typecheck --workspace=infra
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add infra/src/index.ts infra/src/database.ts infra/src/app.ts infra/src/resources.test.ts
git commit -m "feat(infra): source production secrets from deployment inputs"
```

### Task 3: Release Workflow Secret Scoping

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `infra/scripts/release-workflow.test.mjs`
- Create: `infra/src/validate-production-inputs.ts`

**Interfaces:**
- Consumes: the exact environment names parsed by Task 1 and existing release scripts that invoke Pulumi.
- Produces: a fail-fast validation step plus complete, step-scoped mappings on every production Pulumi evaluation/update path.

- [ ] **Step 1: Write failing workflow tests**

Add tests named:

- `validates production deployment inputs before the first AWS mutation`
- `scopes the complete GitHub input set to validation and Pulumi update steps`
- `does not expose production secrets to tests artifacts Docker migrations identity checks or verification`
- `does not copy secret values through GitHub environment outputs arguments or artifacts`
- `validator CLI prints one safe success line and redacts rejected values`
- `retains the empty-stack configuration refresh guard`

Parse the YAML and compare each allowed step's `env` object to the exact nine `secrets.*` mappings and one `vars.LLMOXIE_BASE_URL` mapping. Assert all other steps lack these names. Static-scan workflow `run` bodies for `$GITHUB_ENV`, `$GITHUB_OUTPUT`, and Pulumi `config set` involving these names.

- [ ] **Step 2: Run the workflow tests and verify RED**

Run: `node --test infra/scripts/release-workflow.test.mjs`

Expected: FAIL because the workflow does not yet map or validate deployment inputs.

- [ ] **Step 3: Add fail-fast validation before AWS mutation**

Create `infra/src/validate-production-inputs.ts` as a CLI that calls Task 1's parser with `process.env` and emits only `Production deployment inputs are valid.` on success. After infrastructure installation and before AWS identity/setup or image publication, add a step that maps the exact GitHub environment values and runs `node infra/dist/validate-production-inputs.js`. Exercise the CLI from the Node workflow test with fake values, asserting its exact success output and that a rejected value is absent from stderr.

- [ ] **Step 4: Scope inputs to each Pulumi evaluation/update path**

Map the same ten values onto:

- `Bootstrap base infrastructure only when ECR is absent`;
- `Register candidate while retaining the current service`;
- `Activate migrated candidate`.

Do not place them at job level. Do not add them to refresh, stack-selection, migration, Docker, AWS inspection, or verification steps because those paths do not evaluate the Pulumi program.

- [ ] **Step 5: Run workflow and shell tests**

Run:

```bash
node --test infra/scripts/release-workflow.test.mjs
bash infra/scripts/release-workflow.test.sh
npm run typecheck --workspace=infra
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml infra/src/validate-production-inputs.ts infra/scripts/release-workflow.test.mjs
git commit -m "ci(release): inject protected production secrets"
```

### Task 4: IAM Regression Boundary

**Files:**
- Modify if needed: `infra/account/github-data-policy.json`
- Modify if needed: `infra/account/runtime-permissions-boundary.json`
- Modify: `infra/scripts/bootstrap-policy.test.mjs`
- Modify: `infra/src/resources.test.ts`

**Interfaces:**
- Consumes: the two existing Pulumi-managed secret families, `llteacher-production-runtime-*` and `llteacher-production-database-url-*`.
- Produces: policy tests proving the deploy role can manage only LLTeacher production secrets, the execution role can read only the two runtime families, and the task role has no Secrets Manager access.

- [ ] **Step 1: Strengthen policy tests before changing JSON**

Assert the deploy policy permits lifecycle operations only on `arn:aws:secretsmanager:us-west-2:055237683908:secret:llteacher-production-*`, the runtime boundary permits `GetSecretValue` only for runtime and database URL families, and the resource graph attaches secret-reading policy only to the execution role.

- [ ] **Step 2: Run policy tests**

Run:

```bash
node --test infra/scripts/bootstrap-policy.test.mjs
npm test --workspace=infra -- --run src/resources.test.ts
```

Expected: either RED with the precise least-privilege gap or PASS if the existing policies already implement the approved boundary. Do not edit policy JSON merely to create a diff.

- [ ] **Step 3: Make only evidence-required policy changes**

If Step 2 identifies a real mismatch, minimally adjust the affected policy resource/action set. Do not introduce a database-password source-secret ARN or any wildcard account/region access.

- [ ] **Step 4: Run policy tests and commit**

Run the Step 2 commands again. Expected: PASS.

```bash
git add infra/account/github-data-policy.json infra/account/runtime-permissions-boundary.json infra/scripts/bootstrap-policy.test.mjs infra/src/resources.test.ts
git commit -m "test(infra): lock production secret IAM boundaries"
```

If no tracked file changed, record the passing evidence in the execution ledger and do not create an empty commit.

### Task 5: Production Runbook and Migration Warning

**Files:**
- Modify: `infra/README.md`
- Test: `infra/scripts/release-workflow.test.mjs`

**Interfaces:**
- Consumes: the GitHub names, validation rules, release timing, callback/webhook derivation, and future RDS work from the spec.
- Produces: one operator workflow for initial setup and later updates, with no operator-owned AWS source-secret instructions.

- [ ] **Step 1: Write failing documentation assertions**

Require the production runbook to name all nine GitHub environment secrets, `LLMOXIE_BASE_URL`, `${APP_URL}/api/auth/callback`, `${APP_URL}/api/webhooks/workos`, next-tagged-release semantics, and the RDS-managed-credentials future work. Reject production instructions that tell operators to run `pulumi config set --secret databasePassword` or `runtimeSecrets`.

- [ ] **Step 2: Run the documentation test and verify RED**

Run: `node --test infra/scripts/release-workflow.test.mjs`

Expected: FAIL against the current operator-entered Pulumi secret instructions.

- [ ] **Step 3: Rewrite the production secret runbook**

Document where each provider-issued value comes from, how to generate the database and three 32-byte values, which values cannot be rotated routinely, how the tagged release synchronizes generated AWS secrets, and what a redacted validation failure means. State that operators must not manually edit the generated AWS secrets.

- [ ] **Step 4: Run documentation and infrastructure tests**

Run:

```bash
node --test infra/scripts/release-workflow.test.mjs
npm test --workspace=infra
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/README.md infra/scripts/release-workflow.test.mjs
git commit -m "docs(infra): document GitHub-owned production secrets"
```

### Task 6: Whole-Branch Verification and Review

**Files:**
- Review only: all changes since `origin/staging`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: a verified branch ready for a pull request; no AWS changes and no release tag.

- [ ] **Step 1: Scan for accidental secret handling**

Run:

```bash
git diff --check origin/staging...HEAD
git grep -nE 'AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|WORKOS_API_KEY=|LLMOXIE_API_KEY=' -- . ':!package-lock.json'
rg -n 'GITHUB_ENV|GITHUB_OUTPUT|config set.*(databasePassword|runtimeSecrets)' .github/workflows/release.yml infra
```

Expected: no credentials; any matches are reviewed fixtures, prohibitions, or unrelated safe outputs. No workflow path transmits production secret values through outputs or Pulumi CLI arguments.

- [ ] **Step 2: Run fresh verification**

Run:

```bash
npm run typecheck --workspace=infra
npm test --workspace=infra
CI=true npm test
```

Expected: all commands PASS from the final tree.

- [ ] **Step 3: Request whole-branch review**

Review `origin/staging...HEAD` against the approved spec, with particular attention to secret propagation, Pulumi secret marking, workflow step scope, initial empty-stack behavior, and IAM boundaries. Resolve all blocking findings through focused test-first fix rounds.

- [ ] **Step 4: Verify branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/staging..HEAD
```

Expected: clean worktree and only intentional commits.

- [ ] **Step 5: Push and open the implementation pull request**

Push the existing feature branch and open a pull request targeting `staging`. The PR description must summarize the GitHub-to-Pulumi-to-Secrets-Manager flow, list verification evidence, and state explicitly that it creates no AWS resources until a tagged release runs.

Do not merge the PR or create a release tag.
