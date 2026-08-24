/* --------------------------------------------------------------------------
   RosterImportPanel — CSV roster import, preview first (#86).

   The interaction is two-step and the two steps are not symmetric:

     1. CHOOSE A FILE → the console asks the server what WOULD happen and
        shows one line per row. Nothing is written.
     2. CONFIRM → the same file goes back with preview:false and the rows
        actually land.

   Preview is not a client-side guess. The same endpoint produces both, with
   one flag, so the rows an instructor confirms come from exactly the code
   that will write them -- a separate client-side validator is free to
   disagree with the server, and the disagreement only ever shows up as a
   commit that did something the preview did not promise.

   The file is read in the browser and sent as text rather than as a
   multipart upload. A roster CSV is kilobytes, the Worker parses it either
   way, and text keeps the request shape identical to every other call in the
   console -- no separate body-parsing path to get wrong.
   -------------------------------------------------------------------------- */

import { useId, useRef, useState } from "react";
import { DownloadSimple, Warning } from "@phosphor-icons/react";
import type { RosterImportPayload, RosterRowStatus } from "@llteacher/ui/api";
import { apiClient, ApiError } from "../lib/api-client";

/** Copy per row outcome. `satisfies Record<...>` so a status added on the
 *  server fails to compile here rather than rendering a row with no stated
 *  fate -- which is the one thing this panel exists to prevent.
 *
 *  `tone` drives the marker only, and three of the seven are not failures:
 *  dressing "already enrolled" in the same red as "not a valid email" tells
 *  an instructor something is wrong when nothing is. */
const OUTCOME = {
  added: { tone: "ok", label: "Add", detail: "New to this course." },
  restored: { tone: "ok", label: "Restore", detail: "Previously removed. Access is returned." },
  already_enrolled: { tone: "neutral", label: "No change", detail: "Already on this course." },
  role_conflict: { tone: "warn", label: "Skip", detail: "Already here under another role." },
  invalid_email: { tone: "warn", label: "Skip", detail: "Not a valid email address." },
  disallowed_domain: { tone: "warn", label: "Skip", detail: "Not an allowed email domain." },
  duplicate_row: { tone: "warn", label: "Skip", detail: "This address appears earlier in the file." },
} satisfies Record<RosterRowStatus, { tone: "ok" | "neutral" | "warn"; label: string; detail: string }>;

const TEMPLATE = "email,name,role\r\nalovelace@uw.edu,Ada Lovelace,student\r\nghopper@uw.edu,Grace Hopper,ta\r\n";

/** The extension is a picker hint the OS lets you bypass with "All Files",
 *  so it is re-checked in code. The size cap is about what a roster
 *  plausibly is: a course of 800 students is well under 100KB. */
const ACCEPTED = [".csv", ".txt"];
const MAX_BYTES = 1024 * 1024;

export function RosterImportPanel({
  courseId,
  onImported,
  onAnnounce,
  onClose,
}: {
  courseId: string;
  onImported: () => void;
  onAnnounce: (message: string) => void;
  onClose: () => void;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<RosterImportPayload | null>(null);
  const [committed, setCommitted] = useState<RosterImportPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const headingId = useId();

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPreview(null);
    setCommitted(null);

    const name = file.name.toLowerCase();
    if (!ACCEPTED.some((ext) => name.endsWith(ext))) {
      setError("Choose a .csv file exported from your spreadsheet.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That file is too large to be a roster. Export just the columns you need.");
      return;
    }

    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setBusy(true);
    onAnnounce(`Checking ${file.name}…`);
    try {
      const result = await apiClient.roster.import(courseId, { csv: text, preview: true }, { signal: null });
      setPreview(result);
      onAnnounce(
        `${result.added + result.restored} of ${result.rows.length} rows will be added. Review them before confirming.`,
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not read that file.";
      setError(message);
      onAnnounce(message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!csv || busy) return;
    setBusy(true);
    setError(null);
    onAnnounce("Importing…");
    try {
      const result = await apiClient.roster.import(courseId, { csv, preview: false }, { signal: null });
      setCommitted(result);
      onAnnounce(
        `Imported: ${result.added} added, ${result.restored} restored, ${result.failed} skipped.`,
      );
      // The roster below reloads immediately; the result table stays on
      // screen, because "which four rows were skipped" is the thing the
      // instructor now needs, and a panel that closes on success takes it
      // away at exactly the wrong moment.
      onImported();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not import that file.";
      setError(message);
      onAnnounce(message);
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "llteacher-roster-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const result = committed ?? preview;

  return (
    <section className="admin-accession" aria-labelledby={headingId}>
      <h2 className="admin-accession__eyebrow" id={headingId}>
        Import a roster
      </h2>

      <p className="admin-accession__hint">
        A CSV with an <code>email</code> column. <code>name</code> and <code>role</code> are
        optional; role defaults to student. Nothing is written until you confirm.{" "}
        <button type="button" className="admin-link-button" onClick={downloadTemplate}>
          <DownloadSimple size={13} weight="regular" aria-hidden="true" /> Download a template
        </button>
      </p>

      <div className="admin-accession__actions">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="admin-file-input"
          aria-label="Choose a roster CSV file"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
        {filename && <span className="admin-accession__cap admin-file-name">{filename}</span>}
      </div>

      {error && (
        <div className="admin-alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{error}</span>
        </div>
      )}

      {busy && <p className="admin-loading">Reading the file…</p>}

      {result && (
        <>
          <p className="admin-accession__summary">
            {committed ? (
              <>
                <strong>Imported.</strong> {committed.added} added, {committed.restored} restored,{" "}
                {committed.failed} skipped.
              </>
            ) : (
              <>
                <strong>{result.added + result.restored}</strong> of {result.rows.length} rows will
                be added. {result.failed > 0 && <>{result.failed} will be skipped.</>}
              </>
            )}
          </p>

          <ol className="admin-accession__ledger admin-import-ledger">
            {result.rows.map((row) => {
              const copy = OUTCOME[row.status];
              return (
                <li
                  key={row.line}
                  className={`admin-accession__entry admin-accession__entry--${copy.tone}`}
                >
                  {/* The spreadsheet line number first: an instructor with
                      the file still open needs to find the row, and "row 34"
                      is how they will look for it. */}
                  <span className="admin-import-line">Row {row.line}</span>
                  <span className="admin-accession__netid">{row.email || "(no email)"}</span>
                  <span className="admin-accession__outcome">{copy.label}</span>
                  <span className="admin-accession__detail">{row.message ?? copy.detail}</span>
                </li>
              );
            })}
          </ol>

          {!committed && (
            <div className="admin-accession__actions">
              <button
                type="button"
                className="admin-accession__submit"
                disabled={busy || result.added + result.restored === 0}
                onClick={() => void commit()}
              >
                {result.added + result.restored === 0
                  ? "Nothing to import"
                  : `Import ${result.added + result.restored} ${
                      result.added + result.restored === 1 ? "person" : "people"
                    }`}
              </button>
              <button type="button" className="admin-link-button" onClick={onClose}>
                Cancel
              </button>
            </div>
          )}

          {committed && (
            <div className="admin-accession__actions">
              <button type="button" className="admin-link-button" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
