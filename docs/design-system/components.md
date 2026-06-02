# Component Reference — v2

All components live in `web/src/client/components/`. Import from the barrel:

```tsx
import {
  Sidebar, ConversationView, Message, Composer, CodeBlock, SectionItem,
  Button, Input, Badge, Spinner,
} from "./components";
```

---

## App shell components

### TopNav

The full-bleed UW Husky Purple header bar. 56px tall. Three zones: wordmark (left), breadcrumb (center), user menu (right).

```tsx
<TopNav
  course="STATS 311"
  term="Autumn 2026"
  homework="HW 3 · Probability and Distributions"
  userInitials="AC"
/>
```

Props: `course`, `term`, `homework`, `userInitials`.

**Left zone:** "LLteacher" wordmark in Geist Sans 600, 17px, white. Followed by "· University of Washington" affiliation tag in Geist Mono 11px, `#E8E3D3` Husky Gold web, uppercase, letter-spacing 0.1em.

**Center zone:** `STATS 311 · AUTUMN 2026 · HW 3 · PROBABILITY AND DISTRIBUTIONS` in Geist Mono 12px, small-caps, `#E8E3D3`. Truncates with ellipsis if the viewport is narrow.

**Right zone:** A circular 28px chip in `#B7A57A` Husky Gold print, showing initials in `#32006e` purple. A `›` chevron rotates 90° on click (mock — no dropdown opens). Transition: 140ms ease-out.

Surface: `#32006e`. Bottom rule: `#26005A` 1px.

---

### Sidebar

The section progress rail. The structurally distinctive element of LLTeacher.

```tsx
<Sidebar
  hwNumber={3}
  hwTitle="Probability and Distributions"
  sections={[
    { number: 1, title: "Random variables",          status: "submitted" },
    { number: 2, title: "Probability distributions", status: "submitted" },
    { number: 3, title: "P-values",                  status: "current"   },
    { number: 4, title: "Confidence intervals",      status: "pending"   },
    { number: 5, title: "Hypothesis testing",        status: "pending"   },
  ]}
  currentSection={3}
  hintCount={3}
  onSectionSelect={(n) => console.log("selected", n)}
  onSubmit={(n) => console.log("submit", n)}
  workerStatus="a3f2b1c9"
  workerLoading={false}
/>
```

Props: `hwNumber`, `hwTitle`, `sections: SidebarSection[]`, `currentSection`, `hintCount?`, `onSectionSelect?`, `onSubmit?`, `workerStatus?`, `workerLoading?`.

**Surface:** `#32006e` UW Husky Purple — matches the top nav for unified chrome.

**HW label:** `#B7A57A` Husky Gold print in Geist Mono 11px, uppercase, letter-spacing 0.12em. Structural punctuation — warm metal mark in a purple field.

**Hint history row (`.hint-history-row`):** Three-column row — indicator · label · count — that echoes the section-item rhythm. Leading `▪` in `#B7A57A` Husky Gold print (8px, same family as the `✓` tick and `■`-form marks). Label "Hint history" in Geist Sans 14px, `#E8E3D3` Husky Gold web. Count numeral right-aligned in Geist Mono 12px, `#B7A57A` Husky Gold print — no parentheses. Hover: Spirit Purple `#4b2e83` row fill; white label; Husky Gold print underline under label only (same pattern as section items). `aria-label` carries the full `"N hints used"` string.

**Submit affordance (`.submit-action`):** Bordered two-line button — the dominant action in the sidebar. 1px `#B7A57A` Husky Gold print border, transparent rest background, `var(--radius-sm)` 4px radius. Text is Geist Sans 14px medium, `#E8E3D3` Husky Gold web at rest. Leading `▸` in Husky Gold print. Second row inside the button: `READY TO TURN IN` in Geist Mono 12px small-caps, `#8B73B5` faint lavender — gives the button two-line typographic structure. Hover: Spirit Purple `#4b2e83` fill, Spirit Gold `#FFC700` border, white text, `▸` slides 4px right (140ms ease-out). Active: `#26005A` deeper purple, `scale(0.99)` tactile feedback (100ms). Focus ring: `#FFC700` Spirit Gold via `.sidebar :focus-visible` override.

**Worker colophon:** `#8B73B5` faint lavender — ambient, not essential.

---

### ConversationView

The main column. Renders breadcrumb + message list + composer.

```tsx
<ConversationView
  breadcrumb="STATS 311 · HW 3 · Section 3 P-VALUES"
  messages={messages}
  onSendMessage={(text) => { /* ... */ }}
/>
```

`messages` is `MessageData[]` — a discriminated union on `role: 'ai' | 'student' | 'system'`.
AI message `content` is `React.ReactNode` (may include `<CodeBlock>`).

---

### Message

A single conversation turn. Discriminated union on `role`.

```tsx
<Message role="ai" isStreaming={false}>
  <p>Here is my response.</p>
</Message>

<Message role="student">
  A guess about what's happening?
</Message>

<Message role="system">
  · Section 3 submitted at 11:34 ·
</Message>
```

AI messages with `isStreaming={true}` show the Heritage Gold pulsing dot after the content.

---

### Composer

Sticky compose input with R-mode toggle and Enter-to-submit.

```tsx
<Composer
  value={draft}
  onChange={setDraft}
  onSubmit={(text) => { /* ... */ }}
  placeholder="Ask, explore, or push back…"
/>
```

The `R` toggle on the left switches between Geist Sans (text) and Geist Mono (code) input mode.
Submit fires on Enter (Shift+Enter inserts a newline).
The `enter ↵` hint is visible only when the input is focused.

---

### CodeBlock

Monospace code block with optional R output slot.

```tsx
<CodeBlock lang="r" output="[1] 47">
{`flips <- rbinom(100, 1, 0.5)
sum(flips)`}
</CodeBlock>
```

No rounded corners. Thin top/bottom border rules. Warm code surface.
Output zone renders in a slightly darker surface with "OUTPUT" label.

---

### SectionItem

A single row in the sidebar progress list.

```tsx
<SectionItem
  number={3}
  title="P-values"
  status="current"
  onSelect={(n) => setCurrentSection(n)}
/>
```

Status values and colors (all rendered on Husky Purple `#32006e` bg):
- `"submitted"` — `#B7A57A` Husky Gold print ✓ tick; `#9B8BB8` muted lavender title (decorative exception — status also shown by tick)
- `"current"` — `#FFC700` Spirit Gold ● dot; `#FFFFFF` white title, 500 weight
- `"pending"` — `#6E5A9C` muted lavender ○ outline; `#E8E3D3` Husky Gold web title

Hover: Spirit Purple `#4b2e83` row background; white title; `#B7A57A` Husky Gold print underline under title (gold, not purple — the underline must contrast against the purple bg, not the paper bg).

---

## Utility components

### Button

Text-link or minimal outlined action. Never a vivid filled pill.

```tsx
<Button variant="accent" leadingIcon="▸">Submit Section 3</Button>
<Button variant="default">Cancel</Button>
<Button variant="danger">Delete</Button>
<Button outlined>View all</Button>
```

Variants: `"default"`, `"accent"` (UW Husky Purple), `"danger"` (error red).
Legacy names `"primary"`, `"secondary"`, `"ghost"` are mapped internally.

---

### Input

Labelled form field. Composer styling at smaller scale.

```tsx
<Input
  label="Your answer"
  placeholder="Type here…"
  helperText="Press Enter to submit"
  error="This field is required"
  required
/>
```

Soft surface background, no border at rest, UW Husky Purple border on focus.

---

### Badge

Tiny mono small-caps label. No pill, no vivid fill.

```tsx
<Badge variant="accent">current</Badge>
<Badge variant="success">submitted</Badge>
<Badge outlined>pending</Badge>
```

Variants: `"neutral"`, `"accent"`, `"success"`, `"warning"`, `"danger"`.
`outlined` adds a thin 1px border.

---

### Spinner

The Heritage Gold pulsing dot loading indicator.

```tsx
<Spinner size="sm" label="Loading sections…" />
```

Sizes: `"sm"`, `"md"`, `"lg"`. Reuses the `streaming-dot` CSS animation.

---

## Generative UI components

Components rendered **inline inside an AI message** when the LLM calls a structured tool. The tool render registry in `packages/ui/src/generative/render.tsx` maps tool part types to these components. See [architecture/generative-ui.md](../architecture/generative-ui.md) for the end-to-end loop.

### DefinitionCard

A formal definition rendered as a poster-style typographic block with a custom hand-drawn SVG underline as its signature flourish. Produced by the LLM via the `showDefinition` tool — never instantiated by hand in app code (the tool render registry creates it from streamed tool args).

```tsx
<DefinitionCard
  term="p-value"
  body="The probability of observing a result this extreme — or more — assuming the null hypothesis is true."
  isPartial={false}
/>
```

Props: `term` (string), `body` (string), `isPartial` (boolean, default `false`).

**Layout:** No card chrome (no border, no rounded panel). Subtle warm Heritage Gold wash at 4.5% opacity over the paper surface, 8px corner radius, soft warm shadow. Generous padding (`--space-6` all sides). Stacks vertically: term → signature SVG → body.

**Term:** Geist Sans 600 at `--font-size-2xl` (31px), letter-spacing `-0.022em`, `--color-text`, tight line-height. The card's anchor element.

**Signature underline:** A 120×8 SVG path drawn with a four-stop Bézier wave (`M2 5 Q 25 1, 50 4 T 95 3 T 118 4`), 1.8px stroke in `--color-accent-warm` (Heritage Gold), rounded caps. Animates on mount via `stroke-dashoffset` over 700ms after a 240ms delay — the AI body fade-in completes first, then the gold line traces itself in. Respects `prefers-reduced-motion`: the underline appears in its drawn state without animating.

**Body:** Geist Sans regular at `--font-size-base`, `--leading-body` line-height, `--color-text`.

**Streaming state (`isPartial`):** Renders the entire card at 50% opacity. The tool render registry passes `isPartial = part.state === "input-streaming"` so the card telegraphs "still being generated" while the LLM streams in the args. Becomes fully opaque when `part.state === "input-available"`.

**Accessibility:** The `<aside>` element carries `aria-label={`Definition of ${term}`}`. All decorative SVG and ornaments use `aria-hidden="true"`. Text content uses semantic foreground tokens so contrast against the warm wash meets WCAG AA.

**CSS hook:** `.definition-card`, `.definition-card--partial`, `.definition-card__term`, `.definition-card__signature`, `.definition-card__body` in `packages/ui/styles.css`.
