/* --------------------------------------------------------------------------
   KnowledgeView — the course's OKF bundle, browsable (#42).

   Two panes: a directory rail derived from document paths (there is no
   directory table -- see lib/documentTree.ts) and the selected directory's
   concepts.

   The materials strip below the listing is where the honest-status rule
   becomes visible: a PDF sits at `pending` with the reason showing, because
   #40's extraction pipeline does not exist yet. It is not marked ready and
   it is not hidden. An instructor who needs that PDF grounded can author a
   document against it by hand, which is the escape hatch that makes the
   un-extractable tier usable before #40 lands.
   -------------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from "react";
import { FolderOpen, UploadSimple, Warning, ArrowClockwise } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";
import { ViewLoading, ViewError, ViewEmpty } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { depthOf, directoriesOf, documentsIn, nameOf } from "../lib/documentTree";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { KnowledgeDocumentListPayload, MaterialListPayload } from "@llteacher/ui/api";

const ALLOWED_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md", "vtt", "srt"];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type KnowledgeViewProps = {
  courseId: string;
  onOpenDocument: (documentId: string) => void;
  /** #23: the folder to open on mount. Threaded from App.tsx's own `View`
   *  state so navigating away (e.g. into a document) and back via `onBack`
   *  restores the exact folder the instructor was in, rather than resetting
   *  to root -- this view is unmounted and remounted on that round trip, so
   *  its own useState alone can't survive it. Undefined means root, same as
   *  the bare `useState("")` this replaced. */
  initialDirectory?: string;
  /** Fired whenever the selected folder changes, so the caller can carry it
   *  forward into whatever state needs to reconstruct this screen later. */
  onDirectoryChange?: (directory: string) => void;
};

export function KnowledgeView({
  courseId,
  onOpenDocument,
  initialDirectory,
  onDirectoryChange,
}: KnowledgeViewProps) {
  const [directory, setDirectoryState] = useState(initialDirectory ?? "");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function setDirectory(next: string) {
    setDirectoryState(next);
    onDirectoryChange?.(next);
  }

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
  const directories = useMemo(() => directoriesOf(all), [all]);
  const visible = useMemo(() => documentsIn(all, directory), [all, directory]);
  const materialList = materials.data?.materials ?? [];

  /* Poll only while something is actually in flight, and stop when nothing
     is: a blanket timer would keep an idle console requesting forever, and
     the request is a full listing.

     Deliberately depends on `materials.reload`/`documents.reload` (each a
     stable `useCallback` from useApiResource), not on the `materials`/
     `documents` objects themselves -- those are new object literals every
     render, which would tear down and recreate this interval on every
     unrelated re-render (e.g. the announcement effect above firing) and
     could starve it indefinitely under frequent renders. */
  const pending = materialList.some(
    (m) => m.status === "pending" || m.status === "processing",
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
   *  both of these and is the authority.
   *
   *  I-4 (final review): `apiClient.request()` throws `ApiError` on any
   *  non-2xx response, and this used to await the upload with no `catch` at
   *  all -- a 500/502/503/403 from the server became an unhandled promise
   *  rejection, and the instructor saw the list reload with nothing added
   *  and no explanation. The upload's own `admin-field-error` slot already
   *  existed for the two client-side checks above; a server-side failure
   *  now reports through that same slot rather than vanishing. */
  async function handleFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      setUploadError(
        `Unsupported file type ".${extension}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("File is larger than the 25 MB limit.");
      return;
    }
    setUploadError(null);
    try {
      await apiClient.knowledge.uploadMaterial(courseId, file, { signal: null });
      documents.reload();
      materials.reload();
    } catch (err) {
      setUploadError((err as Error)?.message ?? "Could not upload that file. Please try again.");
    }
  }

  /* #42: the retry affordance for a material the pipeline could not extract.
     It is honest about the no-op: re-running tier-1 conversion on a PDF comes
     back `pending` again, and the material's own error_detail keeps saying why,
     rather than the button implying the next press might differ.

     I-4: same unhandled-rejection gap as handleFile above -- a failed retry
     (the network call itself, not the honest "still pending" response)
     vanished with no signal. Reported through its own slot, mirroring the
     materials-load-failure alert already in this file, rather than reusing
     uploadError: a retry failure is not about the file picker. */
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

  return (
    <div className="admin-view">
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>

      <PageHeader
        eyebrow={`KNOWLEDGE · ${all.length} DOCUMENTS`}
        title="Knowledge base"
        subtitle="Uploaded materials become OKF documents. Group them into collections to ground an assignment."
        actions={
          <label className="admin-button admin-button--primary">
            <UploadSimple size={15} /> Upload material
            <input
              type="file"
              aria-label="Upload material"
              className="admin-visually-hidden"
              accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </label>
        }
      />

      {uploadError && <p className="admin-field-error">{uploadError}</p>}

      {documents.loading && <ViewLoading label="Loading the knowledge base…" />}
      {documents.error && <ViewError error={documents.error} onRetry={documents.reload} />}

      {documents.data && (
        <div className="admin-knowledge">
          <nav className="admin-knowledge__tree" aria-label="Folders">
            {directories.map((dir) => (
              <button
                key={dir || "root"}
                type="button"
                className={
                  dir === directory
                    ? "admin-knowledge__folder admin-knowledge__folder--active"
                    : "admin-knowledge__folder"
                }
                style={{ paddingLeft: `${8 + depthOf(dir) * 14}px` }}
                onClick={() => setDirectory(dir)}
              >
                <FolderOpen size={14} /> {nameOf(dir)}
              </button>
            ))}
          </nav>

          <div className="admin-knowledge__listing">
            {visible.length === 0 ? (
              <ViewEmpty title="No documents yet in this folder." />
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Indexing</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((document, i) => (
                    <tr key={document.id}>
                      <td>
                        <RecordId prefix="DOC" index={i + 1} size="sm" />
                      </td>
                      <td>
                        {/* A button, not a row-level onClick: a bare <tr onClick>
                            is invisible to keyboard navigation and to a screen
                            reader's interactive-elements list. */}
                        <button
                          type="button"
                          className="admin-link-button"
                          onClick={() => onOpenDocument(document.id)}
                        >
                          {document.title ?? document.path}
                        </button>
                      </td>
                      <td>{document.type}</td>
                      <td>
                        <StatusBadge kind={statusKind(document.indexStatus)}>
                          {statusLabel(document.indexStatus)}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <section className="admin-knowledge__materials">
        <h2>Uploaded files</h2>
        {/* I-4: a failed retry attempt (the network call, not an honest
            "still pending" response) used to vanish with no signal at all.
            Mirrors the load-failure alert just below rather than
            uploadError, which is scoped to the file picker. */}
        {retryError && (
          <div className="admin-alert" role="alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>{retryError}</span>
          </div>
        )}
        {materials.error ? (
          /* A materials-load failure does not block the document browser --
             the two panes are independently useful -- but it is reported
             rather than presenting an uploaded-files strip that is silently
             just empty. */
          <div className="admin-alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>
              The uploaded-files list could not be loaded.{" "}
              {materials.canRetry && (
                <button type="button" className="admin-link-button" onClick={materials.reload}>
                  Try again
                </button>
              )}
            </span>
          </div>
        ) : materialList.length === 0 ? (
          !materials.loading && (
            <p className="admin-form-hint">Nothing uploaded yet.</p>
          )
        ) : (
          <ul className="admin-knowledge__material-list">
            {materialList.map((material) => {
              const label = material.originalFilename ?? material.title;
              return (
                <li key={material.id} className="admin-knowledge__material">
                  <span className="admin-knowledge__material-name">{label}</span>
                  <StatusBadge kind={statusKind(material.status)}>
                    {statusLabel(material.status)}
                  </StatusBadge>
                  {material.errorDetail && (
                    <span className="admin-knowledge__material-note">{material.errorDetail}</span>
                  )}
                  {(material.status === "pending" || material.status === "failed") && (
                    <button
                      type="button"
                      className="admin-button admin-button--minimal"
                      onClick={() => void retry(material.id)}
                      aria-label={`Retry ingestion for ${label}`}
                    >
                      <ArrowClockwise size={13} weight="bold" aria-hidden="true" /> Retry
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
