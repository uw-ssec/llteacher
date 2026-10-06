---
type: Bug
title: Release logs hid Pulumi errors via /dev/null and command substitution
description: "First production release failures showed only exit 1: bootstrap sent pulumi up stdout to /dev/null, and after that fix an outer $(...) still captured it; diagnostics now go to stderr, stdout carries only the ECR URL."
tags: [infra, pulumi, ci, shell, release]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["infra/scripts/bootstrap-aws-infra.sh", "infra/scripts/prepare-aws-release.sh", "infra/scripts/aws-release-common.sh", "infra/scripts/aws-release.test.mjs"]
sources:
  - resource: "PR #470"
  - resource: "PR #471"
---

## Symptom

During the first production release, the workflow failed with only `exit code 1` and no actionable Pulumi or AWS message.

## Root cause, in two layers

1. **PR #470:** the bootstrap script sent `pulumi up` stdout to `/dev/null`, so its diagnostics never reached the log.
2. **PR #471:** after stdout was restored, the log was *still* empty. The outer helper `prepare-aws-release.sh production repository` called bootstrap through **command substitution** (`repo=$(...)`) to capture the ECR repository URL, and that swallowed all of bootstrap's stdout, error output included.

## Fix

- Route all Pulumi progress and diagnostics to **stderr**. Keep **stdout** for the single machine-readable value returned through command substitution, the ECR URL.
- The regression test now runs the full wrapper path (`prepare-aws-release.sh`), not just the inner script. The first fix's test passed at the inner level and missed the outer capture.

## Rules for infra shell scripts

- Any script whose stdout is captured by `$(...)` must write logs to stderr (`>&2`).
- Never discard tool output in CI. If it is noisy, redirect it to stderr, not `/dev/null`.
- Test shell contracts end-to-end at the entry point the workflow actually calls. The repo uses fake-binary behaviour tests (`*.test.sh`, `*.test.mjs` under `infra/scripts`) for this.
