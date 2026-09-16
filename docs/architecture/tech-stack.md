# Tech stack

- Runtime: Node 24, Hono 4 via @hono/node-server, on AWS ECS Fargate (single task per environment this quarter). Cloudflare Workers is retired.
- Database: Postgres 16 with pgvector on RDS, Drizzle over node-postgres. `material_chunks` exists but is unused until embeddings return.
- Knowledge base: one OKF v0.2 bundle per course on EFS at `/mnt/knowledge/courses/{courseId}/knowledge`, searched and maintained by the pinned okf 0.3.0 binary. See `docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md`.
- Object storage: S3 for uploaded materials.
- Frontend: React 19, Vite 6, Tailwind 4; packages/ui shared components.
- Auth: WorkOS.
- Infra: Pulumi (TypeScript), see #81.
