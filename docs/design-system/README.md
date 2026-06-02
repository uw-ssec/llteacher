# LLTeacher Design System — v2

Documentation for the v2 LLTeacher design system. The v2 aesthetic is a minimal chat application with a structurally distinctive sidebar: the homework syllabus, not a generic thread list.

Built with React 19, Tailwind 4, and TypeScript on Cloudflare Workers. No new npm dependencies.

## Table of Contents

| Document | Contents |
|---|---|
| [principles.md](./principles.md) | Aesthetic direction, design decisions, what was rejected and why |
| [tokens.md](./tokens.md) | Full token reference — raw palette, semantic aliases, dark mode |
| [components.md](./components.md) | Props tables, usage patterns, accessibility notes |
| [aesthetic.md](./aesthetic.md) | Visual language details: type, color, motion, message rendering |

## Quick Start

All components export from the barrel at `web/src/client/components/index.ts`:

```tsx
import {
  Sidebar,
  ConversationView,
  Message,
  Composer,
  CodeBlock,
  SectionItem,
  Button,
  Input,
  Badge,
  Spinner,
} from "./components";
```

The showcase lives in `web/src/client/App.tsx`. It renders the full app shell with
fixture data (STATS 311, HW 3, Section 3 P-Values conversation).

```bash
cd web
npm run typecheck   # must exit 0
npm test            # must exit 0, 2 tests
npm run build       # must exit 0
```

## File Locations

```
web/src/client/
  styles.css                    Token architecture + component utilities
  App.tsx                       App shell with fixture data
  components/
    Sidebar.tsx                 Section progress rail (the key structural move)
    ConversationView.tsx        Main column: breadcrumb + messages + composer
    Message.tsx                 Single conversation turn (ai / student / system)
    Composer.tsx                Sticky input with R-mode toggle + Enter submit
    CodeBlock.tsx               Code block with optional output slot
    SectionItem.tsx             Single sidebar section row
    Button.tsx                  Text-link or minimal outlined action
    Input.tsx                   Labelled form field (composer styling, smaller)
    Badge.tsx                   Tiny mono small-caps label
    Spinner.tsx                 Heritage Gold pulsing dot loading indicator
    index.ts                    Barrel export

docs/design-system/
  README.md                     This file
  principles.md                 Design decisions and rejections
  tokens.md                     Token reference
  components.md                 Component reference
  aesthetic.md                  Visual language specification
```

## The Structural Move

The left sidebar shows the sections of the current homework assignment — not a list of past conversations. This single decision identifies LLTeacher as a tutoring product, not a general chat interface.

```
HW 3 · PROBABILITY AND DISTRIBUTIONS

  Section 1  Random variables          ✓ submitted
  Section 2  Probability distributions ✓ submitted
  Section 3  P-values                  ● current
  Section 4  Confidence intervals      ○
  Section 5  Hypothesis testing        ○

  ───
  ◇ Hint history (3)
  ▸ Submit Section 3

  ───
  worker: ok · a3f2b1c9
```

## Dependency Policy

No new dependencies without deliberate discussion. The system avoids headless UI libraries, icon libraries, and CSS-in-JS. Reasons:

1. Cloudflare Workers edge runtime makes bundle size meaningful.
2. Accessibility is handled directly in component code.
3. The token system provides theming without a runtime CSS-in-JS engine.
