/* --------------------------------------------------------------------------
   ExportView — end-of-quarter records, and grade disputes (#91).

   Two shapes of the same need. An instructor closing a quarter wants the
   whole course as a spreadsheet; an instructor answering "why did I get
   this mark" wants one student's work, transcript included. Both are the
   same three subjects and the same two formats, so this is one form with a
   scope switch rather than two pages.

   The FERPA sentence is on the page, not in the docs. The moment a file is
   downloaded it is outside every retention and deletion guarantee the
   platform makes, and the person who needs to know that is the person about
   to click the button.
   -------------------------------------------------------------------------- */

import { useCallback, useState } from "react";
import { DownloadSimple, Warning } from "@phosphor-icons/react";
import type { ExportFormat, ExportSubject, RosterMemberPayload } from "@llteacher/ui/api";
import { PageHeader } from "../components/PageHeader";
import { ViewLoading } from "../components/ViewState";
import { apiClient, ApiError } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";

/** `satisfies Record<...>` so a subject added to the wire contract fails to
 *  compile here rather than being quietly unofferable. */
const SUBJECTS = {
  submissions: {
    label: "Submissions",
    help: "Who submitted which section, and when.",
    formats: ["csv", "json"],
  },
  grades: {
    label: "Grades",
    help: "Every recorded grade including superseded ones and AI drafts, with written feedback.",
    formats: ["csv", "json"],
  },
  transcripts: {
    label: "Transcripts",
    help: "Full tutoring conversations, message by message.",
    // A conversation is not a table: one row per message with the text in a
    // cell is expressible and unreadable. The server refuses it too.
    formats: ["json"],
  },
} satisfies Record<ExportSubject, { label: string; help: string; formats: readonly ExportFormat[] }>;

export function ExportView({ courseId, courseTitle }: { courseId: string; courseTitle: string }) {
  const [subject, setSubject] = useState<ExportSubject>("grades");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [studentId, setStudentId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });

  const announce = useCallback(
    (text: string) => setLive((prev) => ({ text, nonce: prev.nonce + 1 })),
    [],
  );

  const roster = useApiResource(
    (opts) => apiClient.roster.list(courseId, {}, opts),
    [courseId],
    { announce, loadingMessage: "Loading the roster…" },
  );

  const allowedFormats: readonly ExportFormat[] = SUBJECTS[subject].formats;
  // Selecting Transcripts while CSV is chosen would otherwise leave the form
  // in a state the server refuses; corrected here so the refusal never has
  // to happen.
  const effectiveFormat: ExportFormat = allowedFormats.includes(format) ? format : allowedFormats[0]!;

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    announce("Building the export…");
    try {
      const artifact = await apiClient.exports.create(
        courseId,
        {
          subject,
          format: effectiveFormat,
          ...(studentId ? { studentId } : {}),
        },
        { signal: null },
      );

      // Built in the browser from the response rather than navigated to:
      // there is no signed URL to hand out (see routes/exports.ts on why
      // this is synchronous), and a Blob keeps the file out of history and
      // out of any proxy cache.
      const blob = new Blob([artifact.body], { type: artifact.contentType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      announce(`${artifact.filename} downloaded.`);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Could not build that export. Please try again.";
      setError(message);
      announce(message);
    } finally {
      setBusy(false);
    }
  }, [busy, courseId, subject, effectiveFormat, studentId, announce]);

  const students = (roster.data?.members ?? []).filter((m) => m.status !== "dropped");

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="EXPORT"
        title={`Export · ${courseTitle}`}
        subtitle="Take this course's records off the platform, for your own files or to answer a grade query."
      />

      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <fieldset className="admin-form-group">
          <legend>What to export</legend>
          {(Object.keys(SUBJECTS) as ExportSubject[]).map((key) => (
            <label key={key} className="admin-form-check">
              <input
                type="radio"
                name="subject"
                checked={subject === key}
                onChange={() => setSubject(key)}
              />
              <span className="admin-form-check__label">
                {SUBJECTS[key].label}
                <span>{SUBJECTS[key].help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="admin-form-group">
          <legend>Format</legend>
          {(["csv", "json"] as const).map((f) => {
            const available = allowedFormats.includes(f);
            return (
              <label
                key={f}
                className={
                  available ? "admin-form-check" : "admin-form-check admin-form-check--disabled"
                }
              >
                <input
                  type="radio"
                  name="format"
                  disabled={!available}
                  checked={effectiveFormat === f}
                  onChange={() => setFormat(f)}
                />
                <span className="admin-form-check__label">
                  {f.toUpperCase()}
                  <span>
                    {/* Shown disabled with the reason rather than hidden: an
                        instructor who expected a spreadsheet should learn why
                        there isn't one, not watch an option vanish. */}
                    {available
                      ? f === "csv"
                        ? "Opens in Excel or Sheets."
                        : "Structured, for scripts and archives."
                      : "Not available for transcripts — a conversation is not a table."}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="admin-form-field">
          <label htmlFor="export-scope">Scope</label>
          {roster.loading ? (
            <ViewLoading label="Loading the roster…" />
          ) : roster.error ? (
            /* #359: a failed roster load and an empty course are different
               facts. Reported inline rather than replacing the page, because
               the whole-course export still works -- an instructor who came
               here for one student's records needs to know the list is
               missing, not to lose the page. */
            <div className="admin-alert">
              <span className="admin-alert__icon" aria-hidden="true">
                <Warning size={16} weight="regular" />
              </span>
              <span>
                The student list could not be loaded, so you can only export the whole course.{" "}
                {roster.error.retryable && (
                  <button type="button" className="admin-link-button" onClick={roster.reload}>
                    Try again
                  </button>
                )}
              </span>
            </div>
          ) : students.length === 0 ? (
            <p className="admin-form-hint">
              Nobody is enrolled in this course yet, so only a whole-course export is available.
            </p>
          ) : (
            <select
              id="export-scope"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
            >
              <option value="">Everyone on this course</option>
              {students.map((m: RosterMemberPayload) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName || m.email}
                </option>
              ))}
            </select>
          )}
          <p className="admin-form-hint">
            One student for a grade query; everyone for your end-of-quarter records.
          </p>
        </div>

        {/* The person who needs this sentence is the person about to click
            the button, not a reader of the data-flow document. */}
        <p className="admin-form-hint admin-export-notice">
          <Warning size={14} weight="regular" aria-hidden="true" /> A downloaded file is no longer
          covered by this platform&apos;s retention or deletion rules. It contains student names,
          email addresses and their work — store it the way your institution requires you to store
          education records.
        </p>

        {error && (
          <div className="admin-alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>{error}</span>
          </div>
        )}

        <div className="admin-form-actions">
          <button type="submit" className="admin-button admin-button--primary" disabled={busy}>
            <DownloadSimple size={14} weight="bold" aria-hidden="true" />
            {busy ? "Building…" : `Download ${SUBJECTS[subject].label.toLowerCase()}`}
          </button>
        </div>
      </form>
    </div>
  );
}
