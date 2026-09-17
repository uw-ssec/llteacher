# Local AWS-shaped deployment

## 1. Required packages

Install these tools before running the infrastructure commands:

1. **Docker Desktop** — runs Floci, Caddy, the application container, and the local PostgreSQL database.
2. **Node.js 24 and npm 10** — build the monorepo, application image, and Pulumi program.
3. **Pulumi CLI 3.234 or newer** — provisions the same TypeScript infrastructure program locally and in AWS.
4. **AWS CLI v2** — inspects Floci's AWS-compatible APIs and real AWS environments.
5. **mkcert** — creates and trusts the certificate for `https://llteacher.local` (`brew install mkcert` on macOS).

Run all commands below from the repository root. Install JavaScript dependencies
once with `npm install`.

## 2. AWS resources

The Pulumi program in `infra/src/` defines one topology for local, staging, and
production environments.

| Resource | Why it is needed |
| --- | --- |
| VPC, two public subnets, internet gateway, and route table | Provide an isolated, routable network for the load balancer, application, and database. |
| Load balancer, application, and database security groups | Restrict inbound traffic between the internet, load balancer, ECS tasks, and PostgreSQL. |
| Application Load Balancer, target group, and HTTPS listener | Route one HTTPS origin to the web app, admin app, and API. |
| ACM certificate | Terminate trusted HTTPS in staging and production. |
| ECS cluster, Fargate service, and task definitions | Run the Node application and the scheduled overdue-work job without managing servers. |
| ECR repository | Store versioned application container images for AWS deployments. |
| RDS PostgreSQL 16, DB subnet group, and pgvector | Persist application data and provide vector search. |
| Secrets Manager | Store the database password and application runtime secrets outside the image and source tree. |
| Private S3 bucket and public-access block | Store course materials without exposing them publicly. |
| IAM roles and policies | Give ECS and deployment jobs only the AWS permissions they require. |
| CloudWatch log groups | Collect application and scheduled-job logs. |
| EventBridge rule and target | Run the overdue-work task every hour. |

## 3. Deploy locally with Floci

Floci emulates the AWS APIs at `http://localhost:4566`. The `local` Pulumi
stack is hard-wired to that endpoint and cannot access an AWS account. Floci
runs in persistent `hybrid` storage mode, with resource data under
`.floci/data`.

### First-time setup

```sh
./infra/scripts/install-local-cert.sh
sudo sh -c 'grep -q "llteacher.local" /etc/hosts || echo "127.0.0.1 llteacher.local" >> /etc/hosts'
```

`mkcert -install` requires human approval to update the operating system trust
store. An automation agent must pause for the user at that prompt; it must not
bypass the HTTPS warning or ask the user to disclose a password.

### Deploy and verify

```sh
npm run aws:local:up
export LLTEACHER_LOCAL_CA="$PWD/.floci/certs/llteacher.local.pem"
npm run aws:local:verify
```

Open the deployed services:

- Application: [https://llteacher.local](https://llteacher.local)
- Admin: [https://llteacher.local/admin](https://llteacher.local/admin)
- Floci API: [http://localhost:4566](http://localhost:4566)
- Floci dashboard: [http://localhost:4500](http://localhost:4500) when the separate `floci-ui` container is running; the repository scripts do not start that optional container.

Stop the local services without deleting their state:

```sh
npm run aws:local:down
```

### What the launcher does

1. Starts or reuses the persistent Floci container and the Caddy TLS proxy.
2. Initializes the file-backed local Pulumi stack and its ignored, owner-only passphrase file.
3. Creates the shared resources and ECR repository on the first run.
4. Builds a freshly tagged application image using `Dockerfile.aws`.
5. Registers the ECS service at zero desired tasks and runs database migrations as a one-off task.
6. Enables the application service only after migrations succeed.
7. Serves the application through Caddy on port 443 and Floci's ALB on port 8443.

The local RDS emulator uses `pgvector/pgvector:pg16`, matching production.
Floci's registry proxy can return `503`, so local deployment uses its supported
canonical-ECR-URI image lookup instead of pushing through the proxy. Production
CI performs a real ECR push.

## 4. Agent operating contract

When Claude, Codex, or another automation agent runs this deployment:

1. Work from the repository root and confirm `PULUMI_STACK=local` before invoking local scripts.
2. Check existing containers and Git state before changing anything; reuse the current Floci resources.
3. Never run `pulumi destroy`, delete `.floci/`, delete `.pulumi/`, remove Docker volumes, or reset local resources without explicit user approval.
4. Never print `.floci/pulumi-passphrase`, Pulumi secret values, database credentials, or application secrets.
5. Never use `curl --insecure` or bypass a browser certificate warning; install and verify the mkcert root instead.
6. Treat `npm run aws:local:up` as idempotent: later runs retain resources and deploy a newly tagged image.
7. Treat `npm run aws:local:verify` exiting successfully as the deployment acceptance check. It verifies `/`, `/admin`, and `/api/health` over HTTPS.
8. On failure, capture the failing command, `docker ps`, and relevant container or Pulumi logs without exposing secrets. Do not destroy the stack as a troubleshooting shortcut.

Local generated state is intentionally ignored by Git:

- `.floci/data/` contains persistent Floci resources.
- `.floci/pulumi-passphrase` decrypts the local Pulumi state.
- `.pulumi/local/` is the file-backed Pulumi state backend.
- `infra/Pulumi.local.yaml` contains generated local stack configuration.
- `infra/Pulumi.local.example.yaml` documents the non-secret baseline.

## 5. Staging and production

Staging and production use the same Pulumi program without Floci endpoint
overrides. They require a real AWS account, Pulumi Cloud state, externally
validated ACM certificates, real ECR pushes, and valid secret values.

Both environments require a Pulumi secret named `runtimeSecrets`. Its JSON
object contains `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `OPENROUTER_API_KEY`,
`LLMOXIE_API_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, and
`WORKOS_WEBHOOK_SECRET`. Pulumi writes this object to Secrets Manager, and ECS
reads only the required keys at task start. Never commit or print these values.
