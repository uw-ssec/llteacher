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

Props: `course`, `term`, `homework`, `userInitials`, `admin` (optional boolean).

**`admin` mode (since `bd5c825`):** when `true`, the affiliation tag in the wordmark zone swaps its leading bullet for a Heritage Gold dot with a soft glow ring, and the tag text becomes `Admin · University of Washington`. The Heritage Gold dot is the at-a-glance "you are in the instructor console" cue across the bar — the admin app uses this mode while the student app omits the prop. The `homework` prop is repurposed in admin to carry the trailing breadcrumb segment (`Instructor Console · Homeworks`, etc.) — the existing uppercase transform handles casing. See [admin-console.md](../architecture/admin-console.md#topnav-admin-mode).

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
  breadcrumb="Section 3: P-Values"
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

### Subject figures (FigurePlate family)

These tools draw a figure inline in an AI turn. Like `DefinitionCard`, they are created only by the tool render registry from streamed tool arguments, never by hand in app code.

The **Pack** column says when the tutor can use each one:
- **shared** tools are always available;
- every other tool belongs to a subject pack, which the instructor turns on under **Subject figures** on the LLM config form;
- a pack that isn't enabled is never offered to the model.

[generative-ui.md](../architecture/generative-ui.md#subject-figures-and-instructor-chosen-packs) has the details.

| Tool | Component | Pack | What it draws |
|---|---|---|---|
| `showWorkedSteps` | `WorkedSteps` | shared | Numbered calculation or derivation steps, with a final result |
| `showMacroModel` | `MacroModelDiagram` | ECON | AD-AS, loanable-funds or money-market curve shifts, with E₁ → E₂ |
| `showGdpComposition` | `GdpComposition` | ECON | GDP = C + I + G + NX as a stacked bar; a negative NX sits left of zero |
| `showMultiplier` | `MultiplierRounds` | ECON | The spending multiplier, round by round |
| `showLaborForce` | `LaborForce` | ECON | Employed, unemployed and not in the labor force, with the three rates |
| `showInflation` | `PriceIndex` | ECON | A price index over time and the inflation it implies |
| `showDiagnosticAccuracy` | `DiagnosticAccuracy` | Clinical informatics | A 2×2 table against a reference standard, with sensitivity, specificity, PPV and NPV |
| `showPrevalenceEffect` | `PrevalenceEffect` | Clinical informatics | How PPV and NPV move with prevalence when sensitivity and specificity are fixed |
| `showRocCurve` | `RocCurve` | Clinical informatics | An ROC curve from threshold points, with the trapezoidal AUC and the best Youden's J threshold marked |
| `showPatientTimeline` | `PatientTimeline` | Clinical informatics | A patient's encounters, labs, medications and events on one dated axis |
| `showCdsRule` | `CdsRule` | Clinical informatics | A decision-support rule's conditions, each one evaluated against a patient, and whether the rule fires |
| `showDistribution` | `DistributionPlot` | Statistics | A normal, t, chi-square or binomial distribution, with a shaded region and its probability |
| `knowledgeCheck` | `KnowledgeCheck` | shared | A multiple-choice check the student answers in place; the tutor judges the answer on its next turn (#36) |

**Computed, never trusted.** The model supplies only arguments. Every number, direction and sentence a figure states is computed from those arguments in `packages/ui/src/generative/lib/` (econ geometry and rates; 2×2 test metrics, Bayes' rule, AUC and rule evaluation; distribution PDFs and CDFs), so the figure cannot contradict itself or the subject. A ratio with a zero denominator reads "undefined", with a note on why, never NaN. Each tool has a deny-by-default parser in `toolInputs.ts` or `toolInputs.clinical.ts`: input that is wrong in type or in meaning renders nothing. Examples are an MPC of 1, ROC points whose sensitivity falls as the false-positive rate rises, or a curve the model doesn't have. The knowledge check has no answer field at all, so nothing in the browser can reveal the answer early.

**Plate.** Every figure sits in `FigurePlate`, styled like a textbook figure rather than a dashboard card:
- a Geist Mono kicker with the same 4px Heritage Gold tick as an AI turn (the tutor produced it);
- a title, then a hairline-ruled figure area on `--color-surface`;
- a computed one-line takeaway;
- a "Show the numbers" disclosure, which is the figure's table view, the same idea as UW DawgPath's "Display data as a table".

**Colour.** Marks use `--viz-1` to `--viz-5`, one categorical order shared by every figure: blue, orange, aqua, violet, magenta. An entity keeps its slot across figures; for example, AD and Consumption are always slot 1.
- The palette was validated with the dataviz checker in both themes; adjacent colourblind separation is ΔE 9.2 in light and 9.4 in dark. The dark steps are chosen separately, not flipped.
- Slots 3 and 5 sit under 3:1 on paper, so every mark carries a visible text label.
- Text never wears a data colour, and Heritage Gold is never used as a data colour.

**Marks.** Lines are 2px. Markers have r ≥ 4 with a 2px surface ring. Gridlines are 1px `--color-border`. A curve's old position is dashed and muted. Axis titles are horizontal, never rotated. Labels are selective: endpoints and the value the story is about.

**Responsive.** SVG text is in viewBox units. A container query (`.gen-figure` is an inline-size container) enlarges it when the figure is narrower than about 460px, so labels stay about 11px on a phone. Steps, the CDS rule's conditions and the knowledge check's options are HTML and reflow.

**States.**
- `input-streaming` before the input validates: a "Drawing the figure…" skeleton plate.
- `input-available` or `output-available`: the figure. Persisted turns replay through `output-available`.
- `output-error` with bad input: nothing.

The whole plate dims to 55% while `isPartial`. Every tool part renders inside `ToolPartErrorBoundary`, so a renderer that throws becomes a quiet "Figure unavailable" plate, not a broken transcript.

**Accessibility.**
- Each `<figure>` carries an `aria-label` that states the computed outcome. For example: "AD shifts left. Price level falls and real GDP falls. Output is below potential: a recessionary gap."
- Each SVG has `role="img"`, and native `<title>` tooltips sit on the marks.
- State is never colour alone: a CDS condition says "met" or "not met" in words, and a shaded region states its probability in text.
- The knowledge check is a native radio group in a `fieldset`, so arrow keys work. Once answered, it locks and says which option was chosen.

**CSS hooks:** `.gen-figure*`, `.gen-svg*`, `.gen-line--N`, `.gen-fill--N`, `.gen-swatch--N`, `.gen-steps*`, `.gen-stat*`, `.gen-area-shade`, `.gen-check*` and the clinical figures' hooks (under "Clinical informatics figures") in `packages/ui/styles.css`.

**Visual review:** with the student app on :2311, run `npm run screenshots:generative-ui`. It renders an ECON 201 thread, a clinical informatics thread and a statistics thread (with knowledge checks) in the real student app (light and dark, 1440, 768 and 390px), saves each figure, and fails on page errors, missing figures or overflow.
