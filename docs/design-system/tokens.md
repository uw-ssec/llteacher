# Token Reference — v2

Three-tier token architecture. All tokens are CSS custom properties defined in
`web/src/client/styles.css`. Only Tier 2 semantic aliases are registered in the
Tailwind 4 `@theme {}` block and generate utility classes.

---

## Architecture

```
Tier 1 (Global)     Raw scale values — never change per brand or theme
                    --raw-bg, --raw-surface, --raw-accent, etc.

Tier 2 (Semantic)   Purpose-named aliases — only layer that changes for dark mode
                    --color-bg, --color-accent, --color-text-muted, etc.

Tier 3 (Component)  Component-specific CSS classes in @layer components
                    .message--ai, .sidebar, .code-block, .composer-wrap, etc.
```

Dark mode is applied by setting `data-theme="dark"` on `<html>`. Only Tier 2
aliases change. All component classes stay identical.

---

## Tier 1 — Raw palette (light)

### Warm neutral scale

| Token | Value | Use |
|---|---|---|
| `--raw-bg` | `#FAFAF7` | Warm off-white page ground |
| `--raw-surface` | `#F2EFE9` | Student bubble, hover states |
| `--raw-surface-raised` | `#F6F3ED` | Sidebar background |
| `--raw-border` | `#E5E1D8` | Standard borders |
| `--raw-border-strong` | `#D4CFC5` | Stronger dividers |
| `--raw-code-bg` | `#F4F1EA` | Code block background |
| `--raw-code-output-bg` | `#EDE9DF` | R output block |

### Text scale

| Token | Value | Use |
|---|---|---|
| `--raw-text` | `#1A1A1A` | Primary text — deep warm black |
| `--raw-text-secondary` | `#6B6760` | Warm gray — muted UI text |
| `--raw-text-muted` | `#94908A` | Very muted — placeholders, metadata |

### UW Husky Purple — dominant chrome surface

The primary brand color per UW guidelines. Now applied as a dominant surface
to the top nav and sidebar. This is not accent usage — Husky Purple IS the
primary, and UW guidelines say primaries "should be used most often."

| Token | Value | UW name | Use |
|---|---|---|---|
| `--raw-accent` | `#32006e` | Husky Purple | Top nav bg, sidebar bg, focus rings, interactive accents on paper |
| `--raw-accent-dark` | `#4b2e83` | Spirit Purple | Sidebar row hover bg, dividers |
| `--raw-accent-faint` | `#EFEAF7` | (derived) | Selected-state surface wash (on paper) |
| `--raw-accent-deeper` | `#26005A` | (derived) | Top nav bottom border — quiet anchor |

### UW Heritage Gold — AI-voice marker on paper

Reserved exclusively for markers that signal "the AI is speaking" — the 4px
speaker tick dot and the streaming pulse dot. Only ever on the paper surface.

| Token | Value | UW name | Use |
|---|---|---|---|
| `--raw-accent-warm` | `#85754d` | Heritage Gold | AI speaker mark, streaming pulse (paper surface only) |
| `--raw-accent-warm-hover` | `#A08E60` | (derived) | Hover state (rarely used) |
| `--raw-gold-web` | `#E8E3D3` | Husky Gold web | Sidebar text (default titles, top nav muted text) on purple |
| `--raw-gold-print` | `#B7A57A` | Husky Gold print | Sidebar HW label, ✓ tick, hover underline, top nav user chip bg |
| `--raw-spirit-gold` | `#FFC700` | Spirit Gold | ● current indicator, submit affordance text |

---

## Tier 2 — Semantic aliases

These are the tokens that component code and Tailwind utilities reference.

### Surfaces

| Alias | Resolves to | Notes |
|---|---|---|
| `--color-bg` | `--raw-bg` | Page background — never pure white |
| `--color-surface` | `--raw-surface` | Student bubble, hover states |
| `--color-surface-raised` | `--raw-surface-raised` | Sidebar |
| `--color-code-bg` | `--raw-code-bg` | Code blocks |
| `--color-code-output-bg` | `--raw-code-output-bg` | R output zones |

### Borders

| Alias | Resolves to |
|---|---|
| `--color-border` | `--raw-border` |
| `--color-border-strong` | `--raw-border-strong` |

### Text

| Alias | Resolves to |
|---|---|
| `--color-text` | `--raw-text` |
| `--color-text-secondary` | `--raw-text-secondary` |
| `--color-text-muted` | `--raw-text-muted` |

### Accent (UW Husky Purple)

| Alias | Resolves to | Use |
|---|---|---|
| `--color-accent` | `--raw-accent` | UW Husky Purple — top nav bg, sidebar bg, focus rings, interactive paper accents |
| `--color-accent-hover` | `--raw-accent-dark` | UW Spirit Purple — hover state on paper surfaces |
| `--color-accent-faint` | `--raw-accent-faint` | Light lavender wash — selected surfaces on paper |

### Accent warm (UW Heritage Gold) — AI-voice markers only (paper surface)

| Alias | Resolves to | Use |
|---|---|---|
| `--color-accent-warm` | `--raw-accent-warm` | Heritage Gold — AI speaker mark, streaming dot |
| `--color-accent-warm-hover` | `--raw-accent-warm-hover` | Hover (rare) |
| `--color-stream` | `--color-accent-warm` | Pulsing dots during AI generation (3-dot wave) |

### Nav surface (top navigation bar)

| Alias | Value | Contrast on bg | Use |
|---|---|---|---|
| `--color-nav-bg` | `#32006e` | — | Top nav background |
| `--color-nav-text` | `#FFFFFF` | ~13:1 ✓ AAA | Wordmark |
| `--color-nav-text-muted` | `#E8E3D3` | ~11:1 ✓ AAA | Affiliation tag, breadcrumb |
| `--color-nav-border` | `#26005A` | — | 1px bottom rule |

### Sidebar surface (section progress rail)

| Alias | Value | Contrast on `#32006e` | Use |
|---|---|---|---|
| `--color-sidebar-bg` | `#32006e` | — | Sidebar background |
| `--color-sidebar-text` | `#E8E3D3` | ~11:1 ✓ AAA | Default section title, utility links |
| `--color-sidebar-text-current` | `#FFFFFF` | ~13:1 ✓ AAA | Current section title |
| `--color-sidebar-text-muted` | `#9B8BB8` | ~3.7:1 decorative | Submitted section title — decorative exception; status also conveyed by ✓ tick |
| `--color-sidebar-text-faint` | `#8B73B5` | ~3.1:1 AA-large | Worker colophon — ambient, not essential |
| `--color-sidebar-hover-bg` | `#4b2e83` | — | Row hover background |
| `--color-sidebar-divider` | `#4b2e83` | — | Horizontal rule |
| `--color-sidebar-hw-label` | `#B7A57A` | ~5.9:1 ✓ AA | HW label, ✓ tick, hover underline |

### Status indicators (on purple background)

| Alias | Value | Contrast on `#32006e` | Use |
|---|---|---|---|
| `--color-status-submitted` | `#B7A57A` | ~5.9:1 ✓ AA | ✓ submitted tick indicator |
| `--color-status-current` | `#FFC700` | ~11.2:1 ✓ AAA | ● current indicator, submit affordance |
| `--color-status-pending` | `#6E5A9C` | decorative | ○ pending outline indicator |

---

## Dark theme overrides

Applied via `[data-theme="dark"]` on `<html>`. Tier 1 raw values are not
changed; only Tier 2 semantic aliases are re-pointed.

| Alias | Dark value |
|---|---|
| `--color-bg` | `#1A1A1A` |
| `--color-surface` | `#222220` |
| `--color-surface-raised` | `#272724` |
| `--color-border` | `#2E2C28` |
| `--color-border-strong` | `#3A3834` |
| `--color-text` | `#FAFAF7` |
| `--color-text-secondary` | `#B5B0AA` |
| `--color-text-muted` | `#7A7570` |
| `--color-accent` | `#C5B4E3` (UW Accent Lavender — designed by UW for dark contexts) |
| `--color-accent-hover` | `#D4C8EC` (lighter lavender) |
| `--color-accent-warm` | `#B7A57A` (UW Husky Gold print value — warmer on dark) |
| `--color-accent-warm-hover` | `#C8B88C` |

---

## Typography scale

Base: 16px. Ratio: 1.250 (Major Third).

| Token | Value | Use |
|---|---|---|
| `--font-size-xs` | `0.75rem` (12px) | Mono labels, metadata, breadcrumb |
| `--font-size-sm` | `0.875rem` (14px) | Sidebar items, captions |
| `--font-size-base` | `1rem` (16px) | Body text, messages |
| `--font-size-lg` | `1.25rem` (20px) | |
| `--font-size-xl` | `1.5625rem` (25px) | |
| `--font-size-2xl` | `1.9375rem` (31px) | |

Line heights: `--leading-tight: 1.3`, `--leading-normal: 1.5`, `--leading-body: 1.7`, `--leading-code: 1.5`.

Font families: `--font-sans: "Geist"`, `--font-mono: "Geist Mono"`.

Both loaded via Google Fonts at the top of `styles.css` (before `@import "tailwindcss"`).

---

## Spacing scale

4px grid, rem-based. `--space-1` through `--space-16`.

---

## Contrast ratios (WCAG 2.2 AA)

### Paper surface (main conversation column)

| Pair | Ratio | Status |
|---|---|---|
| `--color-text` (#1A1A1A) on `--color-bg` (#FAFAF7) | ~18.5:1 | Pass AAA |
| `--color-text-secondary` (#6B6760) on `--color-bg` | ~5.9:1 | Pass AA |
| `--color-accent` (#32006e Husky Purple) on `--color-bg` | ~13.4:1 | Pass AAA |
| `--color-accent-hover` (#4b2e83 Spirit Purple) on `--color-bg` | ~10.2:1 | Pass AAA |
| `--color-accent-warm` (#85754d Heritage Gold) on `--color-bg` | ~4.7:1 | Pass AA |
| `--color-text-muted` (#94908A) on `--color-bg` | ~3.4:1 | AA large text only (decorative metadata) |

### Purple chrome surface (top nav + sidebar, bg: #32006e)

| Pair | Ratio | Status | Notes |
|---|---|---|---|
| White (#FFFFFF) on Husky Purple | ~13:1 | Pass AAA | Wordmark, current section title |
| Husky Gold web (#E8E3D3) on Husky Purple | ~11:1 | Pass AAA | Breadcrumb, default section titles |
| Husky Gold print (#B7A57A) on Husky Purple | ~5.9:1 | Pass AA | HW label, ✓ tick, hover underline |
| Spirit Gold (#FFC700) on Husky Purple | ~11.2:1 | Pass AAA | ● current indicator, submit affordance |
| Muted lavender (#9B8BB8) on Husky Purple | ~3.7:1 | Non-text decorative | Submitted title — status also conveyed by ✓ tick (non-text exception) |
| Faint lavender (#8B73B5) on Husky Purple | ~3.1:1 | AA large text only | Worker colophon — ambient, never essential |

### Dark theme (paper surface)

| Alias | Dark value |
|---|---|
| `--color-text` | `#FAFAF7` (~17.9:1 on dark bg) |
| `--color-accent` | `#C5B4E3` UW Accent Lavender (~9.4:1) |
| `--color-accent-warm` | `#B7A57A` Husky Gold print (~7.6:1) |

Note: `--color-text-muted` and sidebar faint text are used only for decorative or non-essential
text (metadata, ambient colophon). Every essential label uses a token that passes AA for normal text.

The Heritage Gold (#85754d) on the paper surface (~4.7:1) reads as "warm punctuation" against
the cool warm-white ground. Both the purple and the gold are highly legible at their respective
application points.
