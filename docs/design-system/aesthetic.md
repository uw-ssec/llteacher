# Visual Language — v2

Detailed specification of every visual decision: type, color, layout, message rendering,
compose input, motion. This document is the reference for anyone implementing new screens.

---

## Type system

**Body / UI:** Geist Sans (`"Geist"`, 400/500/600 weights).
**Code / metadata / section numbers:** Geist Mono (`"Geist Mono"`, 400/500 weights).

Both loaded via Google Fonts at the top of `styles.css`, before `@import "tailwindcss"`:

```css
@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap");
```

Geist is a modern sans-serif designed by Vercel for code-adjacent product UX. It reads as technically precise but not cold — an appropriate register for a tutoring tool that shows code. Geist Mono pairs with it by design, sharing proportional characteristics.

What was rejected: Inter (invisible, overused), Roboto (invisible, overused), system font stacks (no personality).

---

## Color system

**Three zones, three color jobs.**

**Purple is the chrome.** The top nav and sidebar are both `#32006e` UW Husky Purple. This is not "accent coverage" — per UW brand guidance, primary colors "should be used most often." The sidebar and top nav together form the unified chrome frame of the product. Husky Purple _is_ that frame.

**Heritage Gold is the AI's voice.** `#85754d` appears only in the main conversation column: the 4px speaker tick at the start of each AI turn, and the pulsing streaming dot. Gold marks the AI without decorating anything else.

**Paper is the content.** `#FAFAF7` warm off-white is the main conversation column — the reading surface. Every pixel of student-AI exchange happens on this ground.

---

**Top nav — `#32006e` Husky Purple surface:**
- Wordmark "LLteacher": white `#FFFFFF`
- Affiliation tag "· University of Washington": `#E8E3D3` Husky Gold web
- Course breadcrumb: `#E8E3D3` Husky Gold web in Geist Mono small-caps
- User chip: `#B7A57A` Husky Gold print chip, `#32006e` purple initials
- Bottom rule: `#26005A` (deeper purple)

**Sidebar — `#32006e` Husky Purple surface:**
- HW label: `#B7A57A` Husky Gold print — warm metal mark in a purple field
- Section titles (default): `#E8E3D3` Husky Gold web
- Section titles (current): `#FFFFFF` white, 500 weight
- Section titles (submitted): `#9B8BB8` muted lavender (decorative — also marked by ✓)
- Section Section N numbers: same color as title, Geist Mono
- ✓ submitted indicator: `#B7A57A` Husky Gold print
- ● current indicator: `#FFC700` Spirit Gold — bright, draws the eye
- ○ pending indicator: `#6E5A9C` muted lavender outline
- Hover row background: `#4b2e83` Spirit Purple
- Hover title underline: `#B7A57A` Husky Gold print (not purple — must contrast on the purple bg)
- Divider: `#4b2e83` Spirit Purple
- Hint history row indicator (▪): `#B7A57A` Husky Gold print
- Hint history row label: `#E8E3D3` Husky Gold web (same as default section title)
- Hint history row count: `#B7A57A` Husky Gold print, Geist Mono 12px, right-aligned
- Submit button border (rest): `#B7A57A` Husky Gold print, 1px
- Submit button background (rest): transparent
- Submit button text (rest): `#E8E3D3` Husky Gold web; ▸ in `#B7A57A` Husky Gold print
- Submit button meta line: `READY TO TURN IN` in `#8B73B5` faint lavender, Geist Mono small-caps
- Submit button border (hover): `#FFC700` Spirit Gold
- Submit button background (hover): `#4b2e83` Spirit Purple
- Submit button text (hover): `#FFFFFF` white; ▸ slides 4px right (140ms ease-out)
- Submit button background (active): `#26005A` deeper purple, scale(0.99)
- Focus ring on chrome: `#FFC700` Spirit Gold (`.sidebar :focus-visible`, `.top-nav :focus-visible`)
- Worker colophon: `#8B73B5` faint lavender (ambient text, not essential)

**Main column — `#FAFAF7` warm off-white:**
- Student bubble: `#F2EFE9`
- Code block: `#F4F1EA`
- Code output: `#EDE9DF`
- AI tick mark: `#85754d` Heritage Gold (unchanged)
- Focus borders, composer focus ring: `#32006e` Husky Purple (unchanged — purple appears on the paper as an interactive signal)

---

## App shell layout

Three zones, two tiers. The top nav runs full-bleed across the viewport. Below it, the sidebar and conversation column share the remaining height.

```
┌──────────────────────────────────────────────────────────────────┐
│  [TOP NAV — UW Husky Purple, 56px, full-bleed]                   │
│  LLteacher · UNIVERSITY OF WASHINGTON  |  STATS 311 · AUT 2026… │
│                                        |  HW 3 PROBABILITY…  [AC]│
├───────────────────────────┬──────────────────────────────────────┤
│ Sidebar (240px, purple)   │ Conversation (max 720px, centered)   │
│                           │                                      │
│ HW 3 · PROBABILITY AND…  │ BREADCRUMB (course/hw/section)       │
│                           │                                      │
│ ✓ Section 1 Random variables     │ AI message (no fill)                 │
│ ✓ Section 2 Prob. distributions  │                      Student bubble ▶│
│ ● Section 3 P-values             │ AI message (no fill)                 │
│ ○ Section 4 Conf. intervals      │                                      │
│ ○ Section 5 Hypothesis testing   │ [scrollable]                         │
│ ───                       │ ┌────────────────────────────────┐   │
│ ▪ Hint history        3   │ │ R  Ask, explore, or push back… │   │
│ ┌─────────────────────┐   │ └────────────────────────────────┘   │
│ │▸ Submit Section 3   │   │                                      │
│ │  READY TO TURN IN   │   │                                      │
│ └─────────────────────┘   │                                      │
│ [spacer]                  │                                      │
│ worker: ok · a3f2b1c9     │                                      │
└───────────────────────────┴──────────────────────────────────────┘
```

**Color geography:**
- Top nav + sidebar: UW Husky Purple `#32006e` — unified chrome frame
- Main column: warm off-white `#FAFAF7` — reading surface
- The 1px bottom rule under the top nav (`#26005A`) is the only visual seam between chrome and content

**Context hierarchy across the two breadcrumbs:**
- Top nav breadcrumb: course · term · homework (global context)
- Column breadcrumb: course · homework · section (local context within the current homework)

Both are intentionally present — they answer different questions. The top nav says "where in the course are you?" The column says "which section of this homework?"

---

## Message rendering

### AI message

No bubble. No border. No fill. Pure text in the main column.

No speaker mark or "AI" label — the layout difference vs. the right-aligned student bubble is sufficient to identify the AI's voice (same pattern as Claude and ChatGPT). The Heritage Gold semantic still appears on the streaming dots and the composer's focus border + caret.

Body text: Geist Sans, 16px, line-height 1.7. Paragraphs have 1rem top margin between them.

Streaming: three Heritage Gold dots (`.streaming-dot > span × 3`) oscillating in a staggered wave (1.4s cycle, 200ms offsets). Appended inline after the last character; removed when streaming completes. No "AI is thinking…" text.

### Student message

Right-aligned. Sits inside a soft `#F2EFE9` surface.
Corner radius: `border-radius: 16px 16px 4px 16px`. The bottom-right corner (4px) is the "pointing" corner — the one visual idiosyncrasy that distinguishes this bubble from a generic chat app without being decorative for its own sake.

Max-width: 80% of the conversation column.

### System message

Centered in the column. Very small (12px). Muted. Mono small-caps. No punctuation mark other than the middle dots used as separators. Example: `· Section 3 submitted for grading ·`.

---

## Compose input

At rest: soft `#F6F3ED` background, 12px border-radius, no visible border, 1px subtle shadow.
On focus: thin 1.5px UW Husky Purple border; shadow removed. The transition is 180ms ease-out.

Left edge inside the input: an `R` text-link toggle (not a button in the visual sense). In code mode, the input font switches to Geist Mono and the `R` gets an underline. In text mode, it is muted sans-serif.

Placeholder: `Ask, explore, or push back…` — invites dialogue, not command.

Submit: Enter key (Shift+Enter inserts a newline). A muted `enter ↵` mono mark at the bottom-right fades in only when the input is focused. It is a reminder, not a button.

The textarea resizes with content via CSS `field-sizing: content` with a JS fallback for browsers that do not yet support it.

---

## Sidebar section items

Each section row: indicator (✓ / ● / ○) + Section N number + title text. All rendered on UW Husky Purple `#32006e`.

- `✓` Submitted: Husky Gold print `#B7A57A` tick (~5.9:1 ✓); muted lavender `#9B8BB8` title — status also reinforced by the tick, so non-text AA exception applies
- `●` Current: Spirit Gold `#FFC700` filled dot (~11.2:1 ✓ AAA); white `#FFFFFF` title, 500 weight (~13:1 ✓ AAA)
- `○` Pending: muted lavender `#6E5A9C` outline; Husky Gold web `#E8E3D3` title (~11:1 ✓ AAA)

Hover: the row background shifts to Spirit Purple `#4b2e83`. The title turns white. A thin **Husky Gold print** underline appears under just the title text — gold, not purple, because the underline must contrast against the purple background, not the paper background.

Transition: 120ms ease-out.

The indicator and Section N number are in Geist Mono; the title is Geist Sans.

---

## Submit affordance

The highest-leverage action in the homework. Promoted from a flat text-link to a bordered two-line button.

```
┌──────────────────────────────────────┐  ← 1px #B7A57A border
│ ▸  Submit Section 3                  │  ← Geist Sans 14px medium, #E8E3D3
│    READY TO TURN IN                  │  ← Geist Mono 12px small-caps, #8B73B5
└──────────────────────────────────────┘
```

- Border: 1px `#B7A57A` Husky Gold print — matches the HW label and ✓ ticks; structural, not decorative
- Background: transparent at rest (purple surface shows through)
- Text: Geist Sans 14px, `font-weight: 500`, `#E8E3D3` Husky Gold web
- Leading `▸`: Husky Gold print `#B7A57A`; slides 4px right on hover (140ms ease-out)
- Meta line: `READY TO TURN IN` in Geist Mono 12px small-caps, `#8B73B5` faint lavender — two-line structure echoes the indicator + title rhythm of section items
- Hover: Spirit Purple `#4b2e83` fill, Spirit Gold `#FFC700` border, white text, meta line at 65% opacity white
- Active: `#26005A` deeper purple fill, `scale(0.99)` (100ms)
- Focus: Spirit Gold `#FFC700` ring via `--color-focus-chrome` token

---

## Code blocks

No rounded corners. Thin 1px border rules at top and bottom only. Warm `#F4F1EA` background.

Header row: language label in tiny mono small-caps at the top-right (`R`, `PYTHON`, `JS`).
Code body: Geist Mono, 14px, line-height 1.5, `#1A1A1A` text.

Output zone: `#EDE9DF` background, `OUTPUT` label in same treatment as language label.
Output text: Geist Mono, 14px, `#6B6760` (secondary text).

---

## Motion budget

| Element | Animation | Duration |
|---|---|---|
| Streaming dot | `llteacher-stream-pulse` (opacity 1 → 0.2 → 1) | 1.2s ease-in-out infinite |
| Compose input border on focus | color transition | 180ms ease-out |
| Sidebar section hover underline | scaleX 0→1 | 120ms ease-out |
| Submit ▸ arrow on hover | translateX 4px | 140ms ease-out |
| Submit button active | scale(0.99) | 100ms ease-out |
| Conversation column page load | opacity 0→1, translateY 6→0 | 240ms ease-out |

Nothing else moves. No per-message entrance animations. No scale transforms. No spring physics. Pure CSS only — no Motion library, no Framer Motion.

---

## Breadcrumb

A single line at the top of the conversation column in mono small-caps:

```
STATS 311 · HW 3 · Section 3 P-VALUES
```

Font: Geist Mono, 12px, `letter-spacing: 0.1em`, `text-transform: uppercase`, muted color.
Separated from the first message by a 1px border at bottom, 1.5rem margin below.

This gives location context with zero visual weight. No breadcrumb nav, no chevrons, no interactive links.
