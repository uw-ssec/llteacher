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

## Addendum, 2026-09-17: downloads and the document action bar

Approved against https://claude.ai/artifact/W51qWsKiqK7Wx14P8MznEL.

**Document view header.** At rest: an Edit / Preview toggle (icon pair)
and Save. "Unsaved changes" is a status word beside the toggle. Everything
else lives in a More (⋯) menu: Clean up Markdown, Restore original (only
when an original exists), and a Download group with Markdown and Original
upload (only when the document came from an upload). `ActionMenu` is the
console's new overflow-menu component: menu-button pattern, arrows move,
Escape closes and returns focus, outside click closes, link items are real
anchors.

**Downloads.**

| What | Route | Delivers |
|---|---|---|
| One document | `GET …/knowledge/documents/:id/download` | the `.md` file, named after the last path segment |
| One original upload | `GET …/materials/:id/download` | the stored file under its original name and type |
| Whole knowledge base | `GET …/knowledge/export` | a `.zip` of every Markdown file, paths preserved |

All three answer with `Content-Disposition: attachment`; the console uses
plain anchors so the browser sends the session cookie itself. The zip is
named `<course-slug>-knowledge-<YYYY-MM-DD>-<HHMM>Z.zip` (UTC, marked) so
a folder of exports stays legible. Originals are not bundled: pulling
every stored upload through the server per request is a queued job.

**Where downloads appear.** Knowledge base header ("Download all"); result
rows, folder tables, and the recent list (icon links on hover and focus,
Markdown always, original only when one exists); uploads table (original
per row); the document view's More menu.

## Addendum, 2026-09-17: deletion

Every delete goes through one confirmation modal (`ConfirmDialog`, a
native `<dialog>`: backdrop, focus held inside, Escape cancels, focus
lands on Cancel). The confirm button is the only destructive-styled
control on the page.

- **Document.** "Delete document…" at the bottom of the document view's
  More menu. The modal offers "Also delete the original upload" (checked
  by default) when one exists, so the upload cannot sit at "ready"
  pointing at nothing. `DELETE …/knowledge/documents/:id?withUpload=1`.
- **Upload.** A delete icon per row in All uploads; the existing route
  removes the stored file and the document it produced.
- **Folder.** "Delete folder…" in the selected folder's section header.
  The modal names the folder and its recursive document count, with
  "Also delete the original uploads". New route
  `DELETE …/knowledge/directories/:directory?withUploads=1`; the service
  removes the directory, its originals, regenerates the parent listing,
  and logs the deletion.
- **Whole knowledge base.** "Delete knowledge base…" at the bottom of the
  page header's More menu. The modal requires typing DELETE and offers
  "Also delete every original upload". `DELETE …/knowledge` with
  `{ confirm: "DELETE", withUploads }`; the server checks the phrase too,
  clears the bundle, and re-initialises an empty valid one.
- **No delete on result rows.** A document is deleted from its own page or
  its folder; a hover icon next to download invites misclicks.

The page header now discloses progressively as well: Upload files stays a
button; Upload folder, Download all, and Delete knowledge base sit in a
More menu.
