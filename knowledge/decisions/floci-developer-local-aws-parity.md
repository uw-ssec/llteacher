---
type: Decision
title: "Floci emulates AWS for developers only, using the same Pulumi resource graph as production"
description: "The local stack runs the same TypeScript Pulumi program against Floci (real ECS/RDS-backed containers, no substitute compose services); allowed local differences are values, not topology. Floci never runs in CI."
tags: [infra, local-dev, floci, testing]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: context
code_refs: [infra/scripts/local-up.sh, infra/scripts/floci-up.sh, infra/scripts/verify-local-stack.sh, infra/scripts/local-image-cleanup.sh, infra/Pulumi.local.example.yaml, infra/src/config.ts]
sources:
  - resource: docs/superpowers/plans/2026-09-15-m12-local-aws-design.md
  - resource: docs/superpowers/plans/2026-09-15-floci-github-actions-feasibility.md
  - resource: docs/superpowers/plans/2026-09-15-m12-floci-pulumi-implementation.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: infra/README.md
---

## Spec proposed
The M12 local design (2026-09-15) used Floci for local development **and** disposable CI. It had trusted HTTPS at `llteacher.local` via mkcert, and a feasibility note recommended a Floci GitHub Actions job. The 2026-09-21 design reversed the CI half: "GitHub Actions never runs the local Floci deployment". It also set an "exact parity contract": no Docker Compose Postgres or directly launched app container may stand in for an AWS resource.

## Implemented
- `npm run aws:local:up | verify | test | down` are wrapped by `infra/scripts/*.sh`.
- Floci 2.1.0 creates the actual ECS- and RDS-backed containers.
- `infra/src/config.ts` rejects real AWS endpoints in the local stack and rejects a Floci endpoint in production.
- Local state lives in ignored `.floci/data`, `.pulumi/local`, and `infra/Pulumi.local.yaml`, with an owner-only passphrase file.
- The local origin is `http://localhost:8080`. The mkcert/Caddy TLS proxy was dropped.
- Disk discipline (09-21) was implemented: one replaceable `:local` tag, a dedicated build cache with about a 2 GiB target, and scoped cleanup with no global prune. About 30 GB of stale images was reclaimed during the work.

## Why
Floci shows that the Pulumi graph and integration paths hang together before any real AWS spend or approval. Keeping it out of CI avoids a heavy, flaky Docker-in-CI job. Production verification belongs to the real release.

## Rejected alternatives
- Docker Compose substitutes.
- Floci in GitHub Actions, per branch or as a persistent preview.
- Trusted local HTTPS via mkcert/Caddy.

## Consequences
Floci cannot prove TLS (its HTTPS listener serves plaintext), IAM isolation, public DNS, or AWS network enforcement. Those need real-AWS testing. Never run `pulumi destroy` or delete volumes as a troubleshooting shortcut.

# Related Concepts
- [AWS infrastructure topology (Pulumi, ECS Fargate)](../architecture/infra-topology.md): Floci runs the same Pulumi program locally
- [Infra tests: vitest + node:test in npm test; *.test.sh are manual](../facts/code-infra-tests.md): Infra tests that stub the AWS toolchain
