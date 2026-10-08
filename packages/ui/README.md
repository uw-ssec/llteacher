# @llteacher/ui

Shared design system for the LLteacher monorepo. Consumed by `apps/web` and `apps/admin`.

Contains:
- **`styles.css`** — Tailwind 4 `@theme` token system + utility classes (UW Husky Purple chrome, Heritage Gold AI markers, Geist type)
- **`src/components/`** — React 19 components: `TopNav`, `Sidebar`, `ConversationView`, `Message`, `Composer`, `CodeBlock`, `SectionItem`, `Button`, `Input`, `Badge`, `Spinner`
- **`src/index.ts`** — barrel export for everything

## Usage

In a consuming app's `package.json`:

```json
"dependencies": {
  "@llteacher/ui": "*"
}
```

Then in the app's entry:

```ts
import "@llteacher/ui/styles.css";
import { TopNav, Sidebar, ConversationView } from "@llteacher/ui";
```

No build step required — `exports` points at TypeScript source. Vite handles compilation in each consuming app.

## Design system docs

See `docs/design-system/` at the repo root.

Run `npm run lint:design-system` from the repository root to enforce the shared
tokens and component contracts. See `docs/design-system/lint.md` for the policy
and screenshot review workflow.
