# Design-system verification — 2026-10-07

The configured ShadCN policy passes across both app clients and the shared UI
package. All six rules have negative enforcement probes, and valid shared
tokens, custom CSS, and approved component contracts have positive probes.

## Checks

| Check | Result |
| --- | --- |
| `npm run lint:design-system` | Passed, zero errors or warnings |
| `npm run test:design-system` | 3 passed |
| `pixi run verify` | Passed, including hooks, memory, skill evals, and all 5 workspace typechecks |
| `npm run build` | All 3 build tasks passed |
| Shared UI tests | 313 passed, including 4 Spinner regressions |
| Admin tests | 454 passed |
| Web tests | 2040 passed, 489 database tests skipped |
| Initial lint migration screenshot comparison | 14 passed against renders of the original source |
| Responsive fix screenshots | 43 captures at 1440, 768, 390, and 320px; layout and component assertions passed |
| Desktop preservation | 5 app screens match pre-fix screenshots within 1/255 channel rounding |

Lint's dependencies made JSON Schema declarations visible to the AI SDK. Three
chat test casts now use the SDK's exported `Schema` type; assertions and runtime
behavior stay the same. A stale, ignored local `vite.config.js` shadowed the
current TypeScript config; it was backed up outside the repository and removed
before the successful production build.

## Visual evidence

Baseline Vite instances rendered the original modified files from Git HEAD.
The current instances rendered this worktree. Both used the same deterministic
API fixtures, browser, fonts, locale, timezone, and reduced-motion preference.
Fourteen comparisons cover student conversation, profile, instructor catalog,
homework creation, signed-out landing, and shared controls in light and dark
themes, each at desktop (1440px) and mobile (390px) widths.

All dimensions match. Pixel comparisons allow only one RGB channel step per
pixel (1/255) for rasterization rounding. A worker-status opacity regression
found during comparison was corrected before the final capture.

The local, ignored artifacts are in `artifacts/design-system/baseline/` and
`artifacts/design-system/current/`. Examples:

- [Student conversation](../../artifacts/design-system/current/student-1440.png)
- [Instructor catalog](../../artifacts/design-system/current/admin-1440.png)
- [Shared controls](../../artifacts/design-system/current/components-1440.png)
- [Dark shared controls](../../artifacts/design-system/current/components-dark-390.png)
- [Mobile homework form](../../artifacts/design-system/current/admin-form-390.png)

## Screenshot findings fixed

The original expanded student rails and admin sidebar clipped the main content
at 390px. At widths up to 800px, they now stack above the main column as bounded,
independently scrollable panels. The conversation retains its full available
width; the shell uses dynamic viewport height, and content padding is narrower.
Collapsed panels show only a labelled expansion control, rather than clipped
navigation items. The existing toggle state and persisted preferences remain
unchanged. Mobile catalog actions occupy a separate grid row so they cannot
overlap the homework title.

The original Spinner reserved space without rendering a visible dot. It now
nests its sized dot beneath `.streaming-dot`, matching the existing gold
background, animation, and reduced-motion selectors. Size selectors retain the
intended 5px, 7px, and 9px diameters. Four unit tests guard this structure; browser
checks verify visible dots in both themes and the normal-motion animation.

The follow-up evidence is in `artifacts/design-system/fixed/`, with pre-fix
captures retained in `artifacts/design-system/before-fixes/`. The script checks
viewport containment of the conversation, latest message, and composer; admin
horizontal fit; mobile expansion/collapse and scroll reachability; and catalog
action separation. Examples:

- [Mobile student conversation](../../artifacts/design-system/fixed/student-390.png)
- [Small-phone collapsed navigation](../../artifacts/design-system/fixed/student-collapsed-320.png)
- [Mobile catalog record](../../artifacts/design-system/fixed/admin-record-390.png)
- [Mobile homework form](../../artifacts/design-system/fixed/admin-form-390.png)
- [Visible dark-theme Spinners](../../artifacts/design-system/fixed/components-dark-390.png)

These findings are fixed. The screenshots establish
visual fidelity for the captured states, not universal design compliance,
accessibility, live backend integration, or every application view. CSS values
themselves are outside this plugin's JSX rules; design review remains necessary.
