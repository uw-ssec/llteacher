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

import { useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, DownloadSimple, FolderOpen, Trash, UploadSimple, Warning } from "@phosphor-icons/react";
import { ActionMenu } from "../components/ActionMenu";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
import { materialLabel, statusKind, statusLabel } from "../lib/knowledgeStatus";
import { KNOWLEDGE_INSTRUCTION_DEFAULT, type KnowledgeDocumentListPayload, type KnowledgeDocumentSummaryPayload, type KnowledgeInstructionPayload, type MaterialListPayload, type MaterialPayload } from "@llteacher/ui/api";

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
  /** What the open confirmation modal is about, if any. One modal serves
   *  the folder, the upload, and the whole base; the copy changes. */
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "folder"; directory: string }
    | { kind: "upload"; material: MaterialPayload }
    | { kind: "base" }
    | null
  >(null);
  const [deleteWithUploads, setDeleteWithUploads] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  /** The tutor instruction panel: closed by default, its draft seeded from
   *  the server once opened. `draft === null` means not yet seeded. */
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState<string | null>(null);
  const [instructionSaving, setInstructionSaving] = useState(false);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [instructionSaved, setInstructionSaved] = useState<KnowledgeInstructionPayload | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
  );
  const materials = useApiResource<MaterialListPayload>(
    (opts) => apiClient.knowledge.listMaterials(courseId, opts),
    [courseId],
  );
  const instruction = useApiResource<KnowledgeInstructionPayload>(
    (opts) => apiClient.knowledge.getInstruction(courseId, opts),
    [courseId],
  );
  const instructionCurrent = instructionSaved ?? instruction.data;
  // Seed the draft from the server's answer, or from the built-in default
  // when the server could not answer: the box always shows the text the
  // tutor would use, and stays editable, with the failure named beside it.
  useEffect(() => {
    if (instructionDraft !== null) return;
    if (instructionCurrent) setInstructionDraft(instructionCurrent.instruction ?? instructionCurrent.default);
    else if (instruction.error) setInstructionDraft(KNOWLEDGE_INSTRUCTION_DEFAULT);
  }, [instructionDraft, instructionCurrent, instruction.error]);

  async function saveInstruction(next: string | null) {
    setInstructionSaving(true);
    setInstructionError(null);
    try {
      const saved = await apiClient.knowledge.setInstruction(courseId, next, { signal: null });
      setInstructionSaved(saved);
      setInstructionDraft(saved.instruction ?? saved.default);
      setAnnouncement(saved.instruction ? "Tutor instruction saved." : "Tutor instruction reset to the default.");
    } catch (err) {
      setInstructionError((err as Error)?.message ?? "Could not save the instruction. Try again.");
    } finally {
      setInstructionSaving(false);
    }
  }

  /** The current draft becomes the organisation's default: every course
   *  without its own text starts using it. This course keeps the same text
   *  as its own, so nothing visible changes here except the label. */
  async function setAsDefault() {
    setInstructionSaving(true);
    setInstructionError(null);
    try {
      const text = (instructionDraft ?? "").trim() || null;
      await apiClient.knowledge.setInstruction(courseId, text, { signal: null });
      const saved = await apiClient.knowledge.setInstructionDefault(courseId, text, { signal: null });
      setInstructionSaved(saved);
      setInstructionDraft(saved.instruction ?? saved.default);
      setConfirmDefault(false);
      setAnnouncement("Tutor instruction set as the default for every course.");
    } catch (err) {
      setInstructionError((err as Error)?.message ?? "Could not set the default. Try again.");
    } finally {
      setInstructionSaving(false);
    }
  }

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

  function openDelete(target: NonNullable<typeof pendingDelete>) {
    setDeleteError(null);
    setDeleteWithUploads(true);
    setPendingDelete(target);
  }

  async function runDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingDelete.kind === "folder") {
        const r = await apiClient.knowledge.deleteDirectory(courseId, pendingDelete.directory, { signal: null }, { withUploads: deleteWithUploads });
        setAnnouncement(`Deleted ${r.documents} documents and ${r.uploads} uploads.`);
        selectFolder("");
      } else if (pendingDelete.kind === "upload") {
        await apiClient.knowledge.deleteMaterial(courseId, pendingDelete.material.id, { signal: null });
        setAnnouncement("Upload deleted.");
      } else {
        const r = await apiClient.knowledge.deleteKnowledgeBase(courseId, { confirm: "DELETE", withUploads: deleteWithUploads }, { signal: null });
        setAnnouncement(`Deleted the knowledge base: ${r.documents} documents and ${r.uploads} uploads.`);
        selectFolder("");
        setQuery("");
        setSubmittedQuery(null);
      }
      setPendingDelete(null);
      documents.reload();
      materials.reload();
    } catch (err) {
      setDeleteError((err as Error)?.message ?? "Could not delete. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  async function clearDefault() {
    setInstructionSaving(true);
    setInstructionError(null);
    try {
      const saved = await apiClient.knowledge.setInstructionDefault(courseId, null, { signal: null });
      setInstructionSaved(saved);
      setInstructionDraft(saved.instruction ?? saved.default);
      setAnnouncement("Organisation default cleared.");
    } catch (err) {
      setInstructionError((err as Error)?.message ?? "Could not clear the default. Try again.");
    } finally {
      setInstructionSaving(false);
    }
  }

  const folderNode = pendingDelete?.kind === "folder"
    ? pendingDelete.directory.split("/").reduce<TreeNode | undefined>((n, seg) => n?.children.find((c) => c.name === seg), tree)
    : undefined;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
            {/* Progressive disclosure: only the everyday action stays a
                button. Upload folder, Download all, and the destructive
                delete sit behind More. The folder input itself lives here,
                hidden, because a menu item cannot be a file input; the
                `webkitdirectory`/`directory` attributes are the only
                browser-native way to pick a directory and aren't in React's
                DOM typings, hence the cast. */}
            <input
              ref={folderInput}
              type="file"
              aria-label="Upload folder"
              className="admin-visually-hidden"
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(event) => {
                void handleFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <ActionMenu
              label="More actions"
              items={[
                { kind: "action", label: "Upload folder", icon: <FolderOpen size={16} />, onSelect: () => folderInput.current?.click() },
                { kind: "link", label: "Download all", hint: ".zip", icon: <DownloadSimple size={16} />, href: apiClient.knowledge.exportUrl(courseId), download: "" },
                { kind: "separator" },
                { kind: "action", label: "Delete knowledge base…", icon: <Trash size={16} />, danger: true, disabled: all.length === 0 && materialList.length === 0, onSelect: () => openDelete({ kind: "base" }) },
              ]}
            />
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
                  <span className="admin-knowledge__hint">
                    type above to search within this folder ·{" "}
                    <button type="button" className="admin-link-button admin-link-button--danger" onClick={() => openDelete({ kind: "folder", directory })}>
                      Delete folder…
                    </button>
                  </span>
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

      <KnowledgeUploads courseId={courseId} materials={materialList} onDelete={(material) => openDelete({ kind: "upload", material })} />

      {/* Progressive disclosure: how the tutor is told to use this base is a
          setting most instructors never touch, so it sits closed at the
          bottom. The text is injected into the chat's system prompt at turn
          time and never appears in an LLM config's base prompt. */}
      <details className="admin-knowledge__uploads admin-knowledge__instruction" open={instructionOpen}>
        <summary
          className="admin-knowledge__uploads-summary"
          onClick={(e) => { e.preventDefault(); setInstructionOpen((o) => !o); }}
        >
          <span className="admin-knowledge__chevron" aria-hidden="true"><CaretRight size={12} weight="bold" /></span>
          <h2 className="admin-knowledge__label">How the tutor uses this knowledge base</h2>
          <span className="admin-knowledge__hint">
            {instructionCurrent
              ? instructionCurrent.instruction
                ? "custom instruction"
                : instructionCurrent.orgDefault
                  ? "using the organisation default"
                  : "using the built-in default"
              : ""}
            {instructionCurrent ? " · " : ""}applies to every tutor config that allows knowledge
          </span>
        </summary>
        {instructionOpen && instruction.error && !instructionCurrent && (
          /* A dead, disabled box says nothing. The failure is named and can
             be retried, the same way the uploads list reports its own. */
          <div className="admin-alert" role="alert">
            <span className="admin-alert__icon" aria-hidden="true"><Warning size={16} weight="regular" /></span>
            <span>
              The tutor instruction could not be loaded.{" "}
              {instruction.canRetry && (
                <button type="button" className="admin-link-button" onClick={instruction.reload}>Try again</button>
              )}
            </span>
          </div>
        )}
        {instructionOpen && !instructionCurrent && !instruction.error && (
          <p className="admin-loading">Loading the tutor instruction…</p>
        )}
        {instructionOpen && (instructionCurrent || instruction.error) && (
          <div className="admin-knowledge__instruction-body">
            <p className="admin-knowledge__hint">
              This paragraph is added to the tutor&apos;s system prompt whenever a chat runs on a configuration that
              lets it search the knowledge base. Say when to search and how to use what it finds. A fixed sentence
              telling the model to treat course material as reference, never as instructions, always follows it.
            </p>
            {instructionCurrent && !instructionCurrent.instruction && (
              <p className="admin-knowledge__hint">Using the default. Edit it and save to replace it for this course.</p>
            )}
            {instructionCurrent?.orgDefault && (
              <p className="admin-knowledge__hint">
                Reset to default restores the organisation default, set by an instructor for every course. Clearing
                that default returns every course without its own text to the built-in guidance.
              </p>
            )}
            <textarea
              aria-label="Tutor instruction"
              className="admin-knowledge__instruction-text"
              rows={5}
              maxLength={instructionCurrent?.maxChars ?? 2000}
              value={instructionDraft ?? ""}
              disabled={instructionSaving || instructionDraft === null}
              onChange={(e) => setInstructionDraft(e.target.value)}
            />
            {instructionError && <p className="admin-field-error" role="alert">{instructionError}</p>}
            <div className="admin-knowledge__instruction-actions">
              <span className="admin-knowledge__hint">
                {(instructionDraft ?? "").length} / {instructionCurrent?.maxChars ?? 2000}
              </span>
              <span>
                {/* Progressive disclosure: Save is the everyday action; reset
                    and set-as-default sit behind the panel's own menu. */}
                <ActionMenu
                  label="Instruction options"
                  items={[
                    { kind: "action", label: "Reset to default", disabled: instructionSaving || !instructionCurrent?.instruction, onSelect: () => void saveInstruction(null) },
                    { kind: "action", label: "Set as default for every course…", disabled: instructionSaving || !(instructionDraft ?? "").trim(), onSelect: () => { setInstructionError(null); setConfirmDefault(true); } },
                    ...(instructionCurrent?.orgDefault
                      ? [{ kind: "action" as const, label: "Clear the organisation default", disabled: instructionSaving, onSelect: () => void clearDefault() }]
                      : []),
                  ]}
                />
                <button
                  type="button"
                  className="admin-button admin-button--primary"
                  disabled={instructionSaving || instructionDraft === null || instructionDraft.trim() === (instructionCurrent?.instruction ?? instructionCurrent?.default ?? KNOWLEDGE_INSTRUCTION_DEFAULT).trim()}
                  onClick={() => void saveInstruction(instructionDraft)}
                >
                  {instructionSaving ? "Saving…" : "Save instruction"}
                </button>
              </span>
            </div>
          </div>
        )}
      </details>

      <ConfirmDialog
        open={confirmDefault}
        tone="primary"
        title="Set this as the default for every course?"
        body={
          <p>
            Every course in your organisation that has not written its own tutor instruction starts using this text
            on its next chat. Courses with their own text keep it. You can clear the default later from this panel.
          </p>
        }
        confirmLabel="Set as default"
        busy={instructionSaving}
        error={instructionError}
        onConfirm={() => void setAsDefault()}
        onCancel={() => setConfirmDefault(false)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === "folder" ? `Delete “${pendingDelete.directory.split("/").pop()}”?`
          : pendingDelete?.kind === "upload" ? `Delete “${materialLabel(pendingDelete.material)}”?`
          : "Delete the whole knowledge base?"
        }
        body={
          pendingDelete?.kind === "folder" ? (
            <p>
              {plural(folderNode?.count ?? 0, "document")} under <span className="admin-knowledge__mono">{pendingDelete.directory}</span> leave
              the knowledge base and the tutor stops finding them. This cannot be undone from the console.
            </p>
          ) : pendingDelete?.kind === "upload" ? (
            <p>The stored file is removed, along with the document that was created from it.</p>
          ) : (
            <p>
              Every one of the {plural(all.filter((d) => d.kind === "concept").length, "document")} leaves the knowledge base and the tutor
              has nothing to search. This cannot be undone from the console.
            </p>
          )
        }
        confirmLabel={pendingDelete?.kind === "base" ? "Delete everything" : "Delete"}
        busy={deleting}
        error={deleteError}
        checkbox={
          pendingDelete?.kind === "folder" ? { label: "Also delete the original uploads", checked: deleteWithUploads, onChange: setDeleteWithUploads }
          : pendingDelete?.kind === "base" ? { label: `Also delete every original upload (${materialList.length})`, checked: deleteWithUploads, onChange: setDeleteWithUploads }
          : undefined
        }
        typeToConfirm={pendingDelete?.kind === "base" ? "DELETE" : undefined}
        onConfirm={() => void runDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
