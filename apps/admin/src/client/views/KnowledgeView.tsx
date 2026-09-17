/* --------------------------------------------------------------------------
   KnowledgeView — the course's OKF bundle, search first.

   An instructor comes here to confirm the tutor can find something, to find
   one file by name or by what is inside it, and to see what an upload left
   unfinished. So the search field is the tallest thing on the page and
   takes focus on load; the folder rail is a real collapsible tree; and the
   pane below shows, in order of what is asked of it: uploads filtered from
   the status strip, search results, the selected folder's own documents,
   or -- at rest -- what needs attention and what changed recently.

   Raw uploads live in a closed disclosure at the bottom. They are files,
   not content, and the honest-status rule (a PDF at `pending` with its
   reason showing, never marked ready and never hidden) now reads from the
   "Needs attention" list instead of a thousand-row strip.

   Uploading, retrying, and polling while work is in flight are unchanged
   from the page this replaces.
   -------------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from "react";
import { DownloadSimple, FolderOpen, UploadSimple, Warning } from "@phosphor-icons/react";
import { KnowledgeDownloadTools } from "../components/KnowledgeDownloadTools";
import { KnowledgeAttention } from "../components/KnowledgeAttention";
import { KnowledgeFolderTree } from "../components/KnowledgeFolderTree";
import { KnowledgeSearchField } from "../components/KnowledgeSearchField";
import { KnowledgeSearchResults } from "../components/KnowledgeSearchResults";
import { KnowledgeStatusStrip, type UploadFilter } from "../components/KnowledgeStatusStrip";
import { KnowledgeUploads } from "../components/KnowledgeUploads";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ViewLoading, ViewError } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { ancestorsOf, documentsIn, treeOf, type TreeNode } from "../lib/documentTree";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { KnowledgeDocumentListPayload, KnowledgeDocumentSummaryPayload, MaterialListPayload } from "@llteacher/ui/api";

const ALLOWED_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md", "vtt", "srt"];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const RECENT_ROWS = 8;

export type KnowledgeViewProps = {
  courseId: string;
  onOpenDocument: (documentId: string) => void;
  /** #23: the folder to open on mount. Threaded from App.tsx's own `View`
   *  state so navigating away (e.g. into a document) and back via `onBack`
   *  restores the exact folder the instructor was in, rather than resetting
   *  to root -- this view is unmounted and remounted on that round trip, so
   *  its own useState alone can't survive it. Undefined means root. */
  initialDirectory?: string;
  /** Fired whenever the selected folder changes, so the caller can carry it
   *  forward into whatever state needs to reconstruct this screen later. */
  onDirectoryChange?: (directory: string) => void;
  /** Same round trip for the rail's expanded folders. Undefined means the
   *  default: the root and its immediate children open. */
  initialExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
};

function formatIndexedAt(documents: readonly KnowledgeDocumentSummaryPayload[]): string {
  const latest = documents.reduce((max, d) => (d.updatedAt > max ? d.updatedAt : max), "");
  if (latest === "") return "Not indexed yet";
  const when = new Date(latest);
  const date = when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Last indexed ${date} · ${time}`;
}

function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function DocumentTable({
  courseId, documents, onOpenDocument,
}: { courseId: string; documents: readonly KnowledgeDocumentSummaryPayload[]; onOpenDocument: (id: string) => void }) {
  return (
    <div className="admin-knowledge__table-wrap">
      <table className="admin-table admin-knowledge__doc-table">
        <thead>
          <tr><th>Title</th><th>Type</th><th>Indexing</th><th>Updated</th><th><span className="admin-visually-hidden">Download</span></th></tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id}>
              <td>
                {/* A button, not a row-level onClick: a bare <tr onClick>
                    is invisible to keyboard navigation and to a screen
                    reader's interactive-elements list. */}
                <button type="button" className="admin-link-button" onClick={() => onOpenDocument(document.id)}>
                  {document.title ?? document.path}
                </button>
                <div className="admin-knowledge__mono admin-knowledge__doc-path">{document.path}</div>
              </td>
              <td>{document.type}</td>
              <td>
                <StatusBadge kind={statusKind(document.indexStatus)}>{statusLabel(document.indexStatus)}</StatusBadge>
              </td>
              <td className="admin-knowledge__muted">{formatUpdated(document.updatedAt)}</td>
              <td>
                <KnowledgeDownloadTools courseId={courseId} documentPath={document.path} title={document.title ?? document.path} sourceMaterialId={document.sourceMaterialId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breadcrumb({ directory, onSelect }: { directory: string; onSelect: (dir: string) => void }) {
  const crumbs = ancestorsOf(directory);
  return (
    <nav className="admin-knowledge__crumbs" aria-label="Breadcrumb">
      {crumbs.map((dir, i) => {
        const last = i === crumbs.length - 1;
        const label = dir === "" ? "Knowledge base" : dir.split("/").pop();
        return (
          <span key={dir || "root"}>
            {i > 0 && <span aria-hidden="true"> / </span>}
            {last ? (
              <span className="admin-knowledge__crumb--current" aria-current="page">{label}</span>
            ) : (
              <button type="button" className="admin-knowledge__crumb" onClick={() => onSelect(dir)}>{label}</button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function KnowledgeView({
  courseId,
  onOpenDocument,
  initialDirectory,
  onDirectoryChange,
  initialExpanded,
  onExpandedChange,
}: KnowledgeViewProps) {
  const [directory, setDirectoryState] = useState(initialDirectory ?? "");
  /** null until the instructor touches the rail, or a caller restores it:
   *  the default (root and its children open) depends on the tree, which is
   *  not known until the documents load. */
  const [expanded, setExpandedState] = useState<Set<string> | null>(
    initialExpanded ? new Set(initialExpanded) : null,
  );
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [uploadFilter, setUploadFilter] = useState<UploadFilter | null>(null);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** Non-null only while handleFiles is running. A folder upload posts one
   *  request per file in sequence, so a 500-file folder is a minutes-long
   *  operation that, without this, looked exactly like a page doing nothing. */
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
  );
  const materials = useApiResource<MaterialListPayload>(
    (opts) => apiClient.knowledge.listMaterials(courseId, opts),
    [courseId],
  );

  // Announced through the view's own permanently-mounted live region rather
  // than useApiResource's built-in `announce` option: that option relays the
  // server's own ApiError#message, which for a plain 5xx is the generic
  // "Something went wrong..." sentence -- not this page's language for what
  // failed. Owning the copy here keeps it specific to what an instructor is
  // looking at.
  useEffect(() => {
    if (documents.loading) setAnnouncement("Loading the knowledge base…");
    else if (documents.error) setAnnouncement("Failed to load the knowledge base.");
    else if (documents.data) setAnnouncement(`${documents.data.documents.length} documents loaded.`);
  }, [documents.loading, documents.error, documents.data]);

  const all = documents.data?.documents ?? [];
  const materialList = materials.data?.materials ?? [];
  const tree = useMemo(() => treeOf(all), [all]);
  const expandedSet = useMemo<Set<string>>(() => {
    if (expanded) return expanded;
    return new Set(["", ...tree.children.map((c: TreeNode) => c.path), ...ancestorsOf(directory)]);
  }, [expanded, tree, directory]);
  const inFolder = useMemo(() => documentsIn(all, directory), [all, directory]);
  const recent = useMemo(
    () => all.filter((d) => d.kind === "concept").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_ROWS),
    [all],
  );

  function setDirectory(next: string) {
    setDirectoryState(next);
    onDirectoryChange?.(next);
  }
  function setExpanded(next: Set<string>) {
    setExpandedState(next);
    onExpandedChange?.([...next]);
  }
  function selectFolder(next: string) {
    setDirectory(next);
    setExpanded(new Set([...expandedSet, ...ancestorsOf(next)]));
    setUploadFilter(null);
  }
  function toggleFolder(path: string) {
    const next = new Set(expandedSet);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpanded(next);
  }

  /* Poll only while something is actually in flight, and stop when nothing
     is: a blanket timer would keep an idle console requesting forever, and
     the request is a full listing.

     Deliberately depends on `materials.reload`/`documents.reload` (each a
     stable `useCallback` from useApiResource), not on the `materials`/
     `documents` objects themselves -- those are new object literals every
     render, which would tear down and recreate this interval on every
     unrelated re-render and could starve it indefinitely. */
  const pending = materialList.some(
    (m) => (m.status === "pending" && !m.errorDetail) || m.status === "processing",
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      materials.reload();
      documents.reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [pending, materials.reload, documents.reload]);

  /** Client-side validation is for a fast error only; the server re-checks
   *  both of these and is the authority. Uploads run sequentially (not
   *  Promise.all) so a large folder does not fire dozens of concurrent
   *  requests, and one bad file does not stop the rest: every failure is
   *  collected and reported together at the end. A folder upload hands
   *  this a FileList whose entries carry webkitRelativePath, which rides
   *  along so the server can keep the folder structure. */
  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => f.size > 0 && !f.name.startsWith("."));
    if (files.length === 0) return;
    const failures: string[] = [];
    let successCount = 0;
    let done = 0;
    setUploadError(null);
    setUploadProgress({ done: 0, total: files.length });
    for (const file of files) {
      // Counted before the work, so the line names the file being uploaded
      // right now ("Uploading 12 of 529") rather than the last one finished.
      done += 1;
      setUploadProgress({ done, total: files.length });
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        failures.push(`${file.name}: unsupported file type .${extension}`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        failures.push(`${file.name}: larger than 25 MB`);
        continue;
      }
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined;
      try {
        await apiClient.knowledge.uploadMaterial(courseId, file, { signal: null }, rel);
        successCount += 1;
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error)?.message ?? "upload failed"}`);
      }
    }
    setUploadProgress(null);
    // Only reload when something actually landed server-side: a purely
    // client-side rejection has nothing new to fetch.
    if (successCount > 0) {
      documents.reload();
      materials.reload();
    }
    if (failures.length > 0) {
      setUploadError(`${failures.length} of ${files.length} files failed:\n${failures.join("\n")}`);
    }
  }

  /* The retry affordance for a material the pipeline could not extract. It
     is honest about the no-op: re-running tier-1 conversion on a PDF comes
     back `pending` again, and the material's own error_detail keeps saying
     why. A failed retry call (the network, not an honest "still pending"
     response) is reported through its own slot rather than vanishing. */
  async function retry(materialId: string) {
    setRetryError(null);
    try {
      await apiClient.knowledge.reingestMaterial(courseId, materialId, { signal: null });
      materials.reload();
      documents.reload();
    } catch (err) {
      setRetryError((err as Error)?.message ?? "Could not retry that material. Please try again.");
    }
  }
  async function retryAllFailed() {
    setRetryError(null);
    const failed = materialList.filter((m) => m.status === "failed");
    const failures: string[] = [];
    for (const m of failed) {
      try {
        await apiClient.knowledge.reingestMaterial(courseId, m.id, { signal: null });
      } catch (err) {
        failures.push((err as Error)?.message ?? m.id);
      }
    }
    materials.reload();
    documents.reload();
    if (failures.length > 0) setRetryError(`${failures.length} of ${failed.length} retries could not be sent.`);
  }

  const hasQuery = query.trim() !== "";
  const emptyBundle = documents.data !== null && all.length === 0;

  return (
    <div className="admin-view admin-knowledge">
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>

      <PageHeader
        eyebrow={formatIndexedAt(all)}
        title="Knowledge base"
        actions={
          <>
            <label className="admin-button admin-button--primary">
              <UploadSimple size={15} /> Upload files
              <input
                type="file"
                multiple
                aria-label="Upload files"
                className="admin-visually-hidden"
                accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}
                onChange={(event) => {
                  void handleFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            {/* The two `webkitdirectory`/`directory` attributes are the only
                browser-native way to pick a directory and aren't in React's
                DOM typings, hence the cast. */}
            <label className="admin-button admin-button--ghost">
              <FolderOpen size={15} /> Upload folder
              <input
                type="file"
                aria-label="Upload folder"
                className="admin-visually-hidden"
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(event) => {
                  void handleFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            {/* A real link: the browser downloads the zip with the session
                cookie and the server names the file after the course. */}
            <a className="admin-button admin-button--ghost" href={apiClient.knowledge.exportUrl(courseId)} download="">
              <DownloadSimple size={15} aria-hidden="true" /> Download all
            </a>
          </>
        }
      />

      {/* Deliberately NOT its own live region: this view already has one
          (the announcement <div> above), and a second one updating once per
          file would read 529 interruptions aloud. */}
      {uploadProgress && (
        <div className="admin-knowledge__progress">
          <p className="admin-form-hint">Uploading {uploadProgress.done} of {uploadProgress.total}…</p>
          <progress className="admin-knowledge__progress-bar" value={uploadProgress.done} max={uploadProgress.total} />
        </div>
      )}
      {uploadError && <p className="admin-field-error admin-field-error--multiline">{uploadError}</p>}

      <KnowledgeStatusStrip
        documents={all}
        materials={materialList}
        filter={uploadFilter}
        onFilter={(next) => { setUploadFilter(next); setShowAllAttention(false); }}
      />

      <KnowledgeSearchField
        value={query}
        onChange={(next) => { setQuery(next); setSubmittedQuery(null); setUploadFilter(null); }}
        onSubmit={() => setSubmittedQuery(query.trim())}
        onClear={() => { setQuery(""); setSubmittedQuery(null); }}
        scope={directory === "" ? null : directory}
        onClearScope={() => setDirectory("")}
        busy={false}
      />

      {documents.loading && <ViewLoading label="Loading the knowledge base…" />}
      {documents.error && <ViewError error={documents.error} onRetry={documents.reload} />}

      {documents.data && (
        <div className="admin-knowledge__body">
          <KnowledgeFolderTree
            root={tree}
            selected={directory}
            expanded={expandedSet}
            onSelect={selectFolder}
            onToggle={toggleFolder}
            onCollapseAll={() => setExpanded(new Set([""]))}
          />

          <div className="admin-knowledge__pane">
            {retryError && (
              <div className="admin-alert" role="alert">
                <span className="admin-alert__icon" aria-hidden="true"><Warning size={16} weight="regular" /></span>
                <span>{retryError}</span>
              </div>
            )}
            {materials.error && (
              /* A materials-load failure does not block the document browser
                 -- the two panes are independently useful -- but it is
                 reported rather than presenting an attention list that is
                 silently just empty. */
              <div className="admin-alert">
                <span className="admin-alert__icon" aria-hidden="true"><Warning size={16} weight="regular" /></span>
                <span>
                  The uploads could not be loaded.{" "}
                  {materials.canRetry && (
                    <button type="button" className="admin-link-button" onClick={materials.reload}>Try again</button>
                  )}
                </span>
              </div>
            )}

            {uploadFilter ? (
              <section aria-label={`${uploadFilter} uploads`}>
                <div className="admin-knowledge__section-head">
                  <h2 className="admin-knowledge__label">{uploadFilter === "pending" ? "Pending uploads" : "Failed uploads"}</h2>
                  <span className="admin-knowledge__hint">
                    filtered from the status strip ·{" "}
                    <button type="button" className="admin-link-button" onClick={() => setUploadFilter(null)}>Clear</button>
                  </span>
                </div>
                <KnowledgeAttention
                  materials={materialList}
                  filter={uploadFilter}
                  showAll
                  onShowAll={() => {}}
                  onRetry={(id) => void retry(id)}
                  onRetryAllFailed={() => void retryAllFailed()}
                />
              </section>
            ) : hasQuery ? (
              <KnowledgeSearchResults
                courseId={courseId}
                query={query}
                submittedQuery={submittedQuery}
                scope={directory === "" ? null : directory}
                documents={all}
                onOpenDocument={onOpenDocument}
                onRevealFolder={selectFolder}
              />
            ) : directory !== "" ? (
              <section aria-label="Folder contents">
                <Breadcrumb directory={directory} onSelect={selectFolder} />
                <div className="admin-knowledge__section-head">
                  <h2 className="admin-knowledge__label">
                    {directory.split("/").pop()} · {inFolder.length} {inFolder.length === 1 ? "document" : "documents"}
                  </h2>
                  <span className="admin-knowledge__hint">type above to search within this folder</span>
                </div>
                {inFolder.length === 0 ? (
                  <p className="admin-knowledge__empty">No documents yet in this folder. Open a subfolder in the rail, or search with the folder scope set.</p>
                ) : (
                  <DocumentTable courseId={courseId} documents={inFolder} onOpenDocument={onOpenDocument} />
                )}
              </section>
            ) : emptyBundle ? (
              <p className="admin-knowledge__empty">
                <b>No documents yet.</b> Upload files or a folder to build the knowledge base the tutor searches.
              </p>
            ) : (
              <>
                <section aria-label="Needs attention">
                  <div className="admin-knowledge__section-head">
                    <h2 className="admin-knowledge__label">Needs attention</h2>
                    <span className="admin-knowledge__hint">uploads the pipeline could not finish on its own</span>
                  </div>
                  <KnowledgeAttention
                    materials={materialList}
                    filter={null}
                    showAll={showAllAttention}
                    onShowAll={() => setShowAllAttention(true)}
                    onRetry={(id) => void retry(id)}
                    onRetryAllFailed={() => void retryAllFailed()}
                  />
                </section>
                <section aria-label="Recently updated">
                  <div className="admin-knowledge__section-head">
                    <h2 className="admin-knowledge__label">Recently updated</h2>
                    <span className="admin-knowledge__hint">the last {recent.length} changes across the bundle</span>
                  </div>
                  <DocumentTable courseId={courseId} documents={recent} onOpenDocument={onOpenDocument} />
                </section>
              </>
            )}
          </div>
        </div>
      )}

      <KnowledgeUploads courseId={courseId} materials={materialList} />
    </div>
  );
}
