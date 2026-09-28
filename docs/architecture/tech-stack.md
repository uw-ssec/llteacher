# Tech stack

- Runtime: Node 24, Hono 4 via @hono/node-server, on AWS ECS Fargate (single task per environment this quarter). Cloudflare Workers is retired.
- Database: Postgres 16 with pgvector on RDS, Drizzle over node-postgres. `material_chunks` exists but is unused until embeddings return.
- Knowledge base: one OKF bundle per course, searched and maintained by pinned okf 0.3.0. A temporary working copy is backed by durable course snapshots in the existing S3 bucket; no EFS. Single app task with stop-before-start replacement and brief deployment downtime.
- Object storage: one private, encrypted, versioned S3 bucket for uploaded materials and knowledge snapshots. AWS SDK uses the ECS task role; static credentials are local-only.
- Frontend: React 19, Vite 6, Tailwind 4; packages/ui shared components.
- Auth: WorkOS.
- Infra: Pulumi TypeScript in us-west-2; public ALB/Fargate, private RDS, no NAT, SQS or separate scheduled task. Overdue work runs in-process with a PostgreSQL advisory lock. Developer-local Floci only; GitHub Actions builds/tests/releases to AWS through OIDC. See `infra/README.md` and the September 21 minimal-production design.
