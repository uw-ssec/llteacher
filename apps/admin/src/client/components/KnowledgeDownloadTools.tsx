/* --------------------------------------------------------------------------
   KnowledgeDownloadTools — the per-row download controls.

   Icon-only, revealed on hover and keyboard focus so a list stays quiet
   until a row is wanted; each carries a full accessible name and a title.
   Real anchors: the browser downloads with the session cookie, the server
   answers with an attachment, nothing passes through a Blob.
   -------------------------------------------------------------------------- */

import { DownloadSimple, FileArrowDown } from "@phosphor-icons/react";
import { apiClient } from "../lib/api-client";

export type KnowledgeDownloadToolsProps = {
  courseId: string;
  /** Concept id / path of the document; names the .md file too. */
  documentPath: string;
  title: string;
  sourceMaterialId: string | null;
};

export function KnowledgeDownloadTools({ courseId, documentPath, title, sourceMaterialId }: KnowledgeDownloadToolsProps) {
  const file = `${documentPath.split("/").pop() ?? documentPath}.md`;
  return (
    <span className="admin-knowledge__row-tools">
      <a
        className="admin-knowledge__icon-link"
        href={apiClient.knowledge.documentDownloadUrl(courseId, documentPath)}
        download={file}
        aria-label={`Download Markdown for ${title}`}
        title="Download Markdown"
      >
        <DownloadSimple size={16} aria-hidden="true" />
      </a>
      {sourceMaterialId && (
        <a
          className="admin-knowledge__icon-link"
          href={apiClient.knowledge.materialDownloadUrl(courseId, sourceMaterialId)}
          download=""
          aria-label={`Download original upload for ${title}`}
          title="Download original upload"
        >
          <FileArrowDown size={16} aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
