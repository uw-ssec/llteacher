# Design-system enforcement

See [verification.md](./verification.md) for the checks, screenshot evidence,
and the fixes prompted by screenshot review.

Run `npm run lint:design-system` (or `npm run lint`) from the repository root.
CI runs this check and `npm run test:design-system` after installing dependencies.
The check covers production TypeScript and TSX in both app clients and the shared
UI package; server code and test fixtures are outside the visual policy.

`@shadcn/lint` checks component restyling, raw Tailwind/SVG colors, arbitrary
values, inline styles, unknown classes, and unreadable component classes.
`components.json` points to `design-system.lint.css`, which imports the shared
theme and the two app-specific stylesheets for analysis. This entry is used only
by lint; runtime stylesheet loading stays with each app.

Use `@llteacher/ui` component props for appearance and `packages/ui/styles.css`
semantic tokens for colors. Component implementations may define their own
appearance and computed classes; they still reject raw colors, unknown classes,
and inline styles. Dynamic row delays and search-score widths use CSS custom
properties, with the corresponding declarations in the shared stylesheet.

Three existing treatments are explicitly approved by component contracts:
`btn--restart` and `admin-form-record__remove` on Button, and
`tutor-conversation-item__title` on EditableTitle. Other custom appearance classes
on shared components fail. The exact unknown-class allowlist in
`eslint.config.mjs` preserves existing unstyled structural/DOM hooks (such as
`conversation-log` and `message__sources-item`); it contains no wildcard prefixes.
Review any new contract, token, or exception as a design decision.

The pre-existing React Hooks suppression comments remain supported. This lint
command registers the Hooks plugin for those comments but enables only the
design-system rules.

## Screenshot review

Start the student app with
`npm exec --workspace=llteacher-web -- vite --config vite.config.ts` and the admin
app with `npm run dev --workspace=llteacher-admin`. Then run:

```sh
npx playwright install chromium
npm run screenshots:design-system
```

Screenshots go to the ignored `artifacts/design-system/` directory. Pass a custom
directory after `--` to retain before/after sets. The script captures student
chat, profile, instructor homework catalog, homework creation, and signed-out
pages at 1440px, 768px, 390px, and 320px widths. It renders the real app with deterministic API
fixtures; it does not exercise backend authentication or live model calls.
Review the purple chrome, paper content, typography, controls, responsive layout,
and any changed component states. Lint cannot establish visual fidelity or
validate every CSS declaration; screenshots and human design review remain
necessary.

It also captures the real shared Input, Button, Badge, Spinner, and open TopNav
menu in light and dark themes through `scripts/design-system-showcase.tsx`.
This fixture is served only by the local Vite screenshot route and is not part
of either production app.

The capture also checks that the conversation and composer fit the viewport,
admin content does not overflow horizontally, mobile navigation can expand,
collapse, and scroll to its last action, catalog actions do not overlap titles,
and Spinner dots have visible backgrounds and the correct sizes. Additional
mobile screenshots show expanded/collapsed navigation and the catalog record.

To compare a capture with a reviewed baseline, pass both directories:

```sh
npm run screenshots:design-system -- artifacts/design-system/current artifacts/design-system/baseline
```

The comparison requires identical dimensions and allows at most one RGB channel
step (1/255) per pixel for rasterization rounding. Larger differences fail.
