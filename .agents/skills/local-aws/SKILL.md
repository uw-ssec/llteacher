---
name: local-aws
description:
  Use when the user asks to deploy, verify, or tear down the AWS-shaped stack
  locally with Floci, or when changing infra/ (Pulumi program, deploy scripts,
  Dockerfile.aws) and needing to exercise it without an AWS account.
---

# Local AWS (Floci)

Floci emulates AWS locally. `npm run aws:local:up` runs the **same Pulumi
program** used for production against it, with a file backend and generated
placeholder secrets: no AWS account, credentials, or Pulumi Cloud login.
`infra/README.md` is the long-form guide. Floci is developer-local only; it is
not run in CI.

## Prerequisites

Docker running (`docker info` succeeds), Node 24 and `npm ci`, Pulumi CLI, AWS
CLI v2, jq, curl, OpenSSL. Ports 4566, 8080, and 8443 free. If `docker info`
fails, stop and tell the user to start Docker (`open -a Docker` on macOS); do
not try to work around it.

## Commands (repository root)

| Goal                                   | Command                             |
| -------------------------------------- | ----------------------------------- |
| Deploy (build image, Pulumi, migrate)  | `npm run aws:local:up`              |
| Check the running stack                | `npm run aws:local:verify`          |
| Deploy then verify                     | `npm run aws:local:test`            |
| Migration-runner guard (stubbed, safe) | `npm run aws:local:migration-guard` |
| Stop (keeps volumes and state)         | `npm run aws:local:down`            |

Endpoints: app http://localhost:8080, console http://localhost:8080/admin,
health http://localhost:8080/api/health (its `version` is the image id),
emulator http://localhost:4566.

`aws:local:up` starts `floci/floci:2.1.0`, selects stack `local`, builds
`Dockerfile.aws`, bootstraps ECR if absent, deploys with the service off, runs
`infra/scripts/run-local-migrations.sh`, then turns the service on — the same
migrate-before-activate order as production.

## Limits

- Placeholder secrets mean **WorkOS login and LLM calls do not work** locally
  unless real development credentials are put into encrypted stack config
  (`pulumi config set --secret ... --stack local`, from an owner-only file).
- Floci cannot prove TLS, IAM isolation, DNS, or AWS networking.
- A running stack on :8080 also receives `apps/admin`'s dev `/api` proxy traffic
  (its default target is :8080).

## Rules

- Run `aws:local:up` / `aws:local:test` only when the user asked for a local
  deploy; they build images and change local state.
- Every script refuses a `PULUMI_STACK` other than `local`. NEVER run Pulumi,
  `aws`, or a deploy script against `production` or `staging` from a session;
  production changes go only through the tag-triggered `release.yml` with its
  approval gate.
- NEVER delete `.floci/data`, `.pulumi/local`, `infra/Pulumi.local.yaml`, or
  `.floci/pulumi-passphrase` individually, and never `pulumi destroy`, as a
  troubleshooting shortcut; they only work together.
- NEVER `docker system prune` or prune globally; the scripts clean up by label
  (`org.llteacher.local=true`).
- Never put credentials in shell history, chat, source, or Docker build args.

## Done

`aws:local:up` printed `Local ECS service deployed`, `aws:local:verify` exited
0, and the health response (with its `version`) is pasted into the report — or
the report says exactly which prerequisite was missing.
