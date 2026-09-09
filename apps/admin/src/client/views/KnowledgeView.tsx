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
};

export function KnowledgeView({ courseId, onOpenDocument }: KnowledgeViewProps) {
  const [directory, setDirectory] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
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
  const directories = useMemo(() => directoriesOf(all), [all]);
  const visible = useMemo(() => documentsIn(all, directory), [all, directory]);
  const materialList = materials.data?.materials ?? [];

  /** Client-side validation is for a fast error only; the server re-checks
   *  both of these and is the authority. */
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
    await apiClient.knowledge.uploadMaterial(courseId, file, { signal: null });
    documents.reload();
    materials.reload();
  }

  /* #42: the retry affordance for a material the pipeline could not extract.
     It is honest about the no-op: re-running tier-1 conversion on a PDF comes
     back `pending` again, and the material's own error_detail keeps saying why,
     rather than the button implying the next press might differ. */
  async function retry(materialId: string) {
    await apiClient.knowledge.reingestMaterial(courseId, materialId, { signal: null });
    materials.reload();
    documents.reload();
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
