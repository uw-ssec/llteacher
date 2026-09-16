# Local AWS-shaped deployment

This directory provisions the approved one-service topology through Pulumi.
The `local` stack is hard-wired to Floci at `http://localhost:4566`; it does
not use an AWS account. Staging and production use the same program without
endpoint overrides.

Prerequisites: Docker Desktop, Node 24, Pulumi 3.234+, AWS CLI, and `mkcert`
(`brew install mkcert`). Floci is run in `hybrid` persistent-storage mode with
data under `.floci/data`; normal `aws:local:down`/`up` cycles retain local
development resources.

Run the initial local setup:

```sh
export PULUMI_STACK=local
./infra/scripts/install-local-cert.sh
sudo sh -c 'echo "127.0.0.1 llteacher.local" >> /etc/hosts'
./infra/scripts/local-up.sh
```

The launcher initializes an empty local stack once, creates ECR before an
image exists, then builds a Docker image tagged with Floci's ECR-shaped URI
and enables the service. Later runs retain the existing development resources
and deploy a freshly tagged image. Floci ECS uses that local image directly;
production CI performs a real ECR push.

Each deploy registers the new task definition with the service held at zero,
runs `npm run db:migrate` as a one-off ECS task, and starts the service only
after that task exits successfully.

The launcher creates a random passphrase in the ignored, owner-only
`.floci/pulumi-passphrase` file on its first run and reuses it thereafter.
Normally there is no need to set `PULUMI_CONFIG_PASSPHRASE`; an explicitly set
value overrides the local file for recovery or automation.

`Pulumi.local.yaml` is generated local state and is intentionally ignored.
`Pulumi.local.example.yaml` documents the non-secret baseline configuration.
`floci-down.sh` stops only the local emulator and keeps its development
resources intact.

Floci's ALB emulator currently exposes HTTP on its listener even when the
AWS listener protocol is HTTPS. A small Caddy container therefore terminates
the trusted `mkcert` certificate on public port `443` and forwards to Floci's
ALB on `8443`; the ALB remains the only application router.

The local RDS emulator uses `pgvector/pgvector:pg16`, matching the pgvector
extension enabled by the migration bootstrap on real RDS PostgreSQL.

`verify-local-stack.sh` uses certificate verification, never `--insecure`.
Production requires an externally validated ACM certificate and real secret
values before its stack is applied.

Staging and production also require a Pulumi secret named `runtimeSecrets`: a
JSON object containing `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`OPENROUTER_API_KEY`, `LLMOXIE_API_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`,
`BLIND_INDEX_KEY`, and `WORKOS_WEBHOOK_SECRET`. Pulumi writes it to Secrets
Manager and ECS reads only the needed JSON keys at task start.

## Current Floci limitation

The topology and resource APIs have been applied successfully with Floci
0.2.3. Its registry proxy can return `503`, so the local launcher deliberately
uses Floci's supported canonical-AWS-URI local-image path instead of pushing
through that proxy. This is local-only; production performs a real ECR push.
