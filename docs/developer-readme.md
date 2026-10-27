# LLTeacher 0.4 developer README

LLTeacher’s current application is a TypeScript monorepo with a student app,
an instructor console, and a shared API. This guide covers local development,
verification, and the design system contributors should follow. For the product
overview and instructor onboarding, see the [main README](../README.md).

## Architecture and repository layout

The clients use React 19, Vite, and Tailwind 4. The backend is a Node 24/Hono API
with Drizzle and PostgreSQL. In production, one Node process on AWS ECS Fargate
serves the student app at `/`, the instructor console at `/admin/`, and the API
at `/api`. Pulumi manages the AWS infrastructure.

| Location | Responsibility |
| --- | --- |
| `apps/web/src/client/` | Student React application |
| `apps/web/src/server/` | Shared Hono API used by both clients |
| `apps/web/src/node/` | Node server entry point |
| `apps/web/src/db/` | Drizzle schema, database clients, and migrations |
| `apps/web/src/server/repositories/` | Tenant-scoped application data access |
| `apps/admin/` | Instructor React console; uses the shared API |
| `packages/ui/` | Shared components, styles, tokens, and API types |
| `evals/` | Tutor-behavior and answer-leakage evaluations |
| `infra/` | Pulumi infrastructure, local AWS emulation, and release scripts |
| `docs/design-system/` | Visual design references and enforcement workflow |

See [the web application architecture](../apps/web/ARCHITECTURE.md) for API
boundaries and tenant scoping, and the
[conversation API reference](../apps/web/docs/api/conversations.md) for HTTP contracts.
The older Django implementation remains in the repository; its background is in
[legacy documentation](../legacy_documentation/README.md).

## Prerequisites

- Node.js 24 or newer, matching [`.nvmrc`](../.nvmrc), and npm.
- Pixi for contributor tooling and repository checks.
- A local PostgreSQL database with pgvector for database-backed development.
- Development authentication and model-gateway configuration supplied by the team.
- For the local AWS stack: Docker Desktop, Pulumi CLI, AWS CLI v2, jq, curl,
  OpenSSL, Bash, and [Floci](https://github.com/floci-io/floci), the local AWS
  emulator. The repository launcher starts the pinned `floci/floci:2.1.0`
  Docker image automatically; a separate Floci CLI installation is not required.

The [web app setup guide](../apps/web/README.md#setup) documents backend
configuration and runtime dependencies. The
[local infrastructure guide](../infra/README.md#run-locally) lists the additional
Docker, Pulumi, and AWS CLI prerequisites for running the stack through Floci.

## Install dependencies

Run from the repository root:

```sh
pixi install
npm ci
```

npm workspaces own application, infrastructure, and tutor-evaluation dependencies.
Pixi owns developer tooling such as pre-commit and project-memory tools.

## Run the application locally

First configure the API process using the
[web app setup guide](../apps/web/README.md#setup) and
[development server reference](../.agents/skills/dev-server/SKILL.md).
Set `APP_URL=http://localhost:2311` for the browser origin, use a local database,
and configure development WorkOS credentials, encryption keys, and a
non-production model gateway. Export these variables before starting the API;
the server does not load a local `.env` file automatically.

Apply migrations to the configured local database:

```sh
npm run db:migrate
```

Start the API in one terminal:

```sh
npm run node:serve
```

Start both clients in another terminal:

```sh
LLTEACHER_API_URL=http://localhost:3000 npm run dev
```

| Service | Local address | Configuration |
| --- | --- | --- |
| Student app | `http://localhost:2311` | API proxy uses `NODE_API_URL`, defaulting to `http://localhost:3000` |
| Instructor console | `http://localhost:2312/admin/` | API proxy uses `LLTEACHER_API_URL`, defaulting to `http://localhost:8080` |
| Node API | `http://localhost:3000/api/health` | Server port can be changed with `PORT` |

The command above points the console at the separate Node API on port 3000.
To run only the console, use:

```sh
LLTEACHER_API_URL=http://localhost:3000 npm run dev --workspace=llteacher-admin
```

Use a non-production `LLMOXIE_BASE_URL` together with development credentials;
omitting it defaults to the production gateway. Keep secrets in the backend
process environment: `VITE_*` values are included in the browser bundle.
See the [development server reference](../.agents/skills/dev-server/SKILL.md)
for proxy troubleshooting and authentication redirect setup.

### Run the AWS-shaped stack locally

[Floci](https://github.com/floci-io/floci) runs the application and PostgreSQL containers through the same Pulumi
program used for AWS:

```sh
npm run aws:local:up
npm run aws:local:verify
```

Open `http://localhost:8080` for the student app or
`http://localhost:8080/admin/` for the instructor console. Use
`npm run aws:local:down` to stop the local emulator. Follow the
[infrastructure README](../infra/README.md) for prerequisites, configuration,
local limitations, and the production release procedure.

## Styling and design system

Both clients share the [@llteacher/ui package](../packages/ui/README.md).
Use its exported components and shared stylesheet:

```tsx
import "@llteacher/ui/styles.css";
import { Button, Input } from "@llteacher/ui";
```

Follow the [design-system enforcement policy](./design-system/lint.md):

- Use shared component props to select appearance. Custom appearance classes on
  shared components require an explicit component contract.
- Use semantic tokens from [packages/ui/styles.css](../packages/ui/styles.css)
  rather than raw Tailwind colors, SVG colors, arbitrary values, or inline styles.
- Prefer existing classes. Define new shared classes in the shared stylesheet
  with tokens, and ensure any stylesheet is visible to `design-system.lint.css`.
- Treat new tokens, component contracts, and lint exceptions as design decisions
  that require review.
- Preserve responsive behavior, keyboard access, focus states, light and dark
  themes, and reduced-motion support when changing components.

The established visual direction uses UW Husky Purple for navigation chrome,
paper surfaces for content, Heritage Gold for AI markers, and Geist typography.
Use these references when implementing or reviewing UI work:

| Reference | Use it for |
| --- | --- |
| [Design principles](./design-system/principles.md) | Visual identity and the rationale behind design choices |
| [Tokens](./design-system/tokens.md) | Palette, semantic aliases, typography, and theme tokens |
| [Components](./design-system/components.md) | Component contracts, usage, and accessibility notes |
| [Aesthetic guide](./design-system/aesthetic.md) | Typography, color, motion, and message rendering |
| [Lint and screenshot workflow](./design-system/lint.md) | Current enforcement rules and visual review procedure |
| [Verification record](./design-system/verification.md) | Reviewed visual fixes and verification evidence |

Some early design references use the former `web/` path or Cloudflare runtime.
Use the current repository layout above and shared component implementations
for file locations and runtime details.

### Check visual changes

Run the design checks from the repository root:

```sh
npm run lint:design-system
npm run test:design-system
```

For visible UI changes, start both Vite clients and capture screenshots:

```sh
npx playwright install chromium
npm run screenshots:design-system
```

Review the generated PNGs in `artifacts/design-system/`, including mobile widths
and light/dark component states. The captures use deterministic API fixtures;
they check rendering rather than live authentication or model responses. Add
coverage for new screens or states that existing captures do not exercise.
Lint and viewport checks supplement human visual review. See the
[screenshot review instructions](./design-system/lint.md#screenshot-review)
for capture directories and baseline comparisons.

## Verification and common commands

Run commands from the repository root:

| Goal | Command |
| --- | --- |
| Repository quality gate | `pixi run verify` |
| Typecheck TypeScript workspaces | `npm run typecheck` |
| Run workspace tests | `npm test` |
| Build the clients and other buildable workspaces | `npm run build` |
| Check the design system | `npm run lint:design-system` |
| Test design-rule enforcement | `npm run test:design-system` |
| Evaluate tutor behavior | `npm run tutor:eval` |

Scope commands when appropriate, for example
`npm test --workspace=llteacher-admin`. The repository gate covers pre-commit,
project-memory validation, agent-skill evaluations, and TypeScript checks.
Application changes also need the relevant tests; client, Vite, and shared UI
changes need a build, and visible changes need screenshot review.

Database-backed web tests skip when `DATABASE_URL` is absent. Use a disposable
local database for those suites and report skipped tests. Follow the
[test-running guide](../.agents/skills/run-tests/SKILL.md) for setup and cache
behavior, and the [verification guide](../.agents/skills/verify/SKILL.md) for the
complete quality gate.

## Contribution guidance and project memory

Read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AI_POLICY.md](../AI_POLICY.md)
before contributing. Pull requests target `staging`. AI assistants should start
with [AGENTS.md](../AGENTS.md) for repository rules and area-specific workflows.

Search project memory before changing an area or revisiting a recorded decision:

```sh
pixi run okf search --for-path apps/web/src/client/App.tsx
pixi run okf search "design system" --limit 3
```

The [documentation index](./README.md),
[tutor evaluation README](../evals/README.md), and
[infrastructure README](../infra/README.md) provide further references.
