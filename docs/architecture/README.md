# Architecture

Documentation for cross-cutting architectural concerns in the LLTeacher v2 port. Component-level design specs live in [`../design-system/`](../design-system/README.md); implementation plans live in [`../superpowers/plans/`](../superpowers/plans/).

## Documents

| Document | Contents |
|---|---|
| [generative-ui.md](./generative-ui.md) | End-to-end Generative UI loop: chat route, tool registry, DefinitionCard, recipe for adding new tools |
| [dev-api-proxy.md](./dev-api-proxy.md) | Why the Vite dev API proxy exists, how it routes `/api/*` to the Hono Worker in dev, and when to remove it |
| [admin-console.md](./admin-console.md) | Instructor admin app: editorial catalog aesthetic, view navigation, fixture data shapes mapped to Django models, sidebar collapse, TopNav `admin` mode, and the gitignore `lib/` footgun |
| [db-driver-split.md](./db-driver-split.md) | Why there are two Drizzle DB clients (`client.ts` vs `nodeClient.ts`): the Neon HTTP driver can't reach plain Postgres (local/CI), doesn't affect prod, and what to revisit later |
| [webr-self-hosting.md](./webr-self-hosting.md) | Why WebR (client-side R) is self-hosted rather than loaded from a CDN, the `webr.mjs` vs. `webr.js` bug real-browser verification caught, `ChannelType`/COOP/COEP, and asset materialization |
