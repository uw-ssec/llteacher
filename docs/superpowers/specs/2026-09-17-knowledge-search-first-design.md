# Knowledge base: search-first redesign

Approved 2026-09-17 against the interactive mockup
(https://claude.ai/artifact/Smyvt9o7ZVhJQVEfyQ8kGc, version 4).

## Problem

The knowledge page treated search as a widget, flattened every folder into
one uncollapsible list, showed bare concept ids as results, and ended in a
1,000-row list of raw uploads that nobody scrolls. An instructor's real
jobs, in order of frequency, are: confirm the tutor can find something,
find one file by name or content, check what failed after an upload,
browse structure occasionally, and bulk upload at term start.

## Design

**Search hero.** One tall field under the header, focused on load. Typing
matches titles and paths instantly, client-side, over the already-loaded
document list. Enter, or a 450 ms pause after three or more characters,
runs the tutor's BM25 content search. The submit control is an icon button
inside the field. A clear button appears when there is text; Esc clears.

**One results list, one toggle.** A segmented control switches between
"Inside documents" (ranked content hits) and "File names" (instant name
matches), each labelled with its count. A sort menu offers Relevance
(content only), Name, and Last updated. Ten rows show; "Show all N" reveals
the rest. Result rows: title with query terms highlighted, type badge,
status badge when not indexed, clickable path segments that reveal the
folder in the rail, description with highlights, and a gold bar showing
score relative to the top hit.

**Folder scope.** Selecting a folder in the rail places an "in <folder>"
chip inside the field. Both lists filter to that subtree. Content search
sends the folder as `dir`; the server over-fetches from okf, filters by
prefix, and returns up to the requested limit so a scoped search is not
starved by the global top-20.

**Folder rail.** A real tree: chevron per folder, one level open by
default, recursive document counts, a marker when anything inside is not
indexed, "Collapse all". Expansion and selection survive a drill-in and
back through App view state, alongside the existing `directory`.

**Status strip.** Documents, indexed, pending, failed, uploads. Pending
and failed are buttons that filter the pane to those uploads.

**Pane at rest.** No query, no folder: "Needs attention" (pending with a
reason, and failed, five rows then Show all, retry per row and Retry all
failed) plus "Recently updated". Folder selected: breadcrumb and a table
of that folder's own documents. Query present: the results list.

**All uploads.** A closed disclosure at the bottom, filterable by file
name, paged at 25.

**Eyebrow.** "Last indexed <date> · <time>", derived from the newest
document `updatedAt`. Nothing else, since the count already sits in the
strip.

**Unchanged.** Upload files, upload folder, sequential upload with
progress, retry, and polling while work is in flight.

## Visual tokens

Every color comes from `packages/ui/styles.css`. Statuses map to the
console's own badge kinds: indexed/ready to `active`, pending/processing
to `scheduled`, failed to `missing`. Hover and active tints reuse the
Heritage Gold alphas the folder rail already uses. Focus uses the
search-input focus rule. Geist and Geist Mono as everywhere else.

## Components

- `lib/documentTree.ts`: `treeOf(documents)` builds a nested tree with
  `count` (concepts, recursive) and `attention` (not-indexed, recursive);
  `ancestorsOf(path)`.
- `components/KnowledgeFolderTree.tsx`: the rail.
- `components/KnowledgeSearchField.tsx`: the field, scope chip, hints.
- `components/KnowledgeSearchResults.tsx`: fetch, toggle, sort, cap.
- `components/KnowledgeStatusStrip.tsx`: counts and filter chips.
- `components/KnowledgeAttention.tsx`: uploads needing a human.
- `components/KnowledgeUploads.tsx`: the disclosure with filter and pages.
- `views/KnowledgeView.tsx`: composition, upload handling, polling.
- `KnowledgeSearchBox.tsx` is removed.

## Server

`GET /knowledge/search?q=&limit=&dir=`: `dir` optional, validated with the
same directory pattern as `createDirectory`; the service filters hits to
`dir/` and fills up to `limit`.
