# Development API proxy

The web development environment uses two Node processes:

1. `npm run node:serve --workspace=llteacher-web` starts the Hono API and reads its required values from the process environment.
2. `npm run dev --workspace=llteacher-web` starts Vite on port 2311. Vite serves the student client and forwards `/api/*` to `NODE_API_URL` (default `http://localhost:3000`).

This matches production's Node/ECS runtime: route handlers execute in the Hono application, while Vite is only a development asset server and reverse proxy. The admin client is started from its own workspace when needed.

## Configuration

Export the server variables in the shell that starts `node:serve`, or load them with your preferred local environment manager. At minimum the server validates `APP_URL`, `DATABASE_URL`, WorkOS credentials, provider credentials, and the session/encryption/webhook secrets at startup. `APP_URL` must be an HTTP(S) origin with no path, query, or fragment.

Set `NODE_API_URL` only when the API is listening somewhere other than `http://localhost:3000`:

```sh
NODE_API_URL=http://localhost:4000 npm run dev --workspace=llteacher-web
```

## Request flow

```text
browser -> Vite :2311 -> /api proxy -> Hono Node server :3000 -> PostgreSQL/providers
```

Vite and the Node server both set the cross-origin isolation headers required by the client. Streaming API responses pass through Vite's built-in proxy without a repository-specific adapter.

## Agent checks

- Confirm both processes are running before diagnosing an API 404 or connection refusal.
- Inspect `apps/web/vite.config.ts` for the current proxy target and ports.
- Never place secrets in client-prefixed Vite variables; the Node process owns all server secrets.
- Use `curl http://localhost:3000/api/health` to test the API directly and `curl http://localhost:2311/api/health` to test the proxy path.
