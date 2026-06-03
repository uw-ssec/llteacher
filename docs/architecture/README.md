# Architecture

Documentation for cross-cutting architectural concerns in the LLTeacher v2 port. Component-level design specs live in [`../design-system/`](../design-system/README.md); implementation plans live in [`../superpowers/plans/`](../superpowers/plans/).

## Documents

| Document | Contents |
|---|---|
| [generative-ui.md](./generative-ui.md) | End-to-end Generative UI loop: chat route, tool registry, DefinitionCard, recipe for adding new tools |
| [dev-api-proxy.md](./dev-api-proxy.md) | Why the Vite dev API proxy exists, how it routes `/api/*` to the Hono Worker in dev, and when to remove it |
| [admin-console.md](./admin-console.md) | Instructor admin app: editorial catalog aesthetic, view navigation, fixture data shapes mapped to Django models, sidebar collapse, TopNav `admin` mode, and the gitignore `lib/` footgun |
