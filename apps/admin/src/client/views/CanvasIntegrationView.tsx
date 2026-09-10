/* --------------------------------------------------------------------------
   CanvasIntegrationView — #73/#74: the org's Canvas API token, and this
   course's link + roster sync against it.

   Two sections, deliberately sequential rather than tabs: the course
   picker (section 2) needs a working token to populate at all, so an
   instructor without one yet is guided there first rather than shown an
   empty picker with no explanation.

   Instructor-only, same as TaCapabilitiesView/StudentsView -- App.tsx gates
   the nav entry and the view on canAuthor, matching every backing route
   here being requireInstructorOf.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, CloudArrowDown, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { abortAfter } from "../lib/abortAfter";
import type {
  CanvasCourseOption,
  CanvasCredentialSummary,
  CanvasSyncResponse,
  CanvasSyncStatusResponse,
} from "@llteacher/ui/api";

async function errorMessageFor(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* non-JSON body — fall through */
  }
  if (res.status === 403) return "Your permissions changed. Reload the console.";
  if (res.status >= 500) return `${fallback.replace(/\.$/, "")}. Please try again.`;
  return fallback;
}

export function CanvasIntegrationView({
  courseId,
  courseTitle,
}: {
  courseId: string;
  courseTitle: string;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const [live, setLive] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const announce = useCallback(
    (text: string) => setLive((prev) => ({ text, nonce: prev.nonce + 1 })),
    [],
  );

  // ---- Section 1: the org's Canvas token ----
  const [credential, setCredential] = useState<CanvasCredentialSummary | null | undefined>(undefined);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [editingCredential, setEditingCredential] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("https://");
  const [savingCredential, setSavingCredential] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);

  const loadCredential = useCallback(() => {
    announce("Loading Canvas token settings…");
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
    fetch(`/api/courses/${courseId}/canvas/credential`, { signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessageFor(r, "Could not load Canvas token settings."));
        return r.json() as Promise<{ credential: CanvasCredentialSummary | null }>;
      })
      .then((data) => {
        setCredential(data.credential);
        setCredentialError(null);
        if (data.credential) setBaseUrlInput(data.credential.canvasBaseUrl);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        setCredentialError((err as Error).message || "Could not load Canvas token settings.");
        setCredential(null);
      })
      .finally(dispose);
  }, [courseId, announce]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    loadCredential();
    return () => controller.abort();
  }, [loadCredential]);

  const saveCredential = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSavingCredential(true);
      setCredentialError(null);
      announce("Saving Canvas token…");
      const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
      try {
        const res = await fetch(`/api/courses/${courseId}/canvas/credential`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: tokenInput, canvasBaseUrl: baseUrlInput }),
          signal,
        });
        if (!res.ok) {
          const message = await errorMessageFor(res, "Could not save that token.");
          setCredentialError(message);
          announce(message);
          return;
        }
        const data = (await res.json()) as { credential: CanvasCredentialSummary | null };
        setCredential(data.credential);
        setEditingCredential(false);
        setTokenInput("");
        setValidation(null);
        announce("Canvas token saved.");
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message = "Could not save that token. Please try again.";
        setCredentialError(message);
        announce(message);
      } finally {
        dispose();
      }
    },
    [courseId, tokenInput, baseUrlInput, announce],
  );

  const deleteCredential = useCallback(async () => {
    const confirmed = window.confirm(
      "Remove this organization's Canvas token?\n\nCourses linked to Canvas will stop being able to sync until a new token is entered.",
    );
    if (!confirmed) return;
    announce("Removing Canvas token…");
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/credential`, { method: "DELETE", signal });
      if (!res.ok) {
        const message = await errorMessageFor(res, "Could not remove that token.");
        setCredentialError(message);
        announce(message);
        return;
      }
      setCredential(null);
      setValidation(null);
      announce("Canvas token removed.");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      announce("Could not remove that token. Please try again.");
    } finally {
      dispose();
    }
  }, [courseId, announce]);

  const validateCredential = useCallback(async () => {
    setValidating(true);
    setValidation(null);
    announce("Validating Canvas token…");
    const { signal, dispose } = abortAfter(20_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/credential/validate`, {
        method: "POST",
        signal,
      });
      if (!res.ok) {
        const message = await errorMessageFor(res, "Could not validate that token.");
        setValidation({ ok: false, message });
        announce(message);
        return;
      }
      const body = (await res.json()) as { ok: boolean; message?: string; name?: string | null };
      const message = body.ok
        ? `Token works — connected as ${body.name ?? "your Canvas account"}.`
        : body.message ?? "That token did not work.";
      setValidation({ ok: body.ok, message });
      announce(message);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setValidation({ ok: false, message: "Could not reach Canvas. Please try again." });
    } finally {
      setValidating(false);
      dispose();
    }
  }, [courseId, announce]);

  // ---- Section 2: course link + sync ----
  const [status, setStatus] = useState<CanvasSyncStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [courseOptions, setCourseOptions] = useState<CanvasCourseOption[] | null>(null);
  const [courseOptionsError, setCourseOptionsError] = useState<string | null>(null);
  const [loadingCourseOptions, setLoadingCourseOptions] = useState(false);
  const [selectedCanvasCourseId, setSelectedCanvasCourseId] = useState("");
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<CanvasSyncResponse | null>(null);

  const loadStatus = useCallback(() => {
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
    fetch(`/api/courses/${courseId}/canvas/status`, { signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessageFor(r, "Could not load this course's Canvas sync status."));
        return r.json() as Promise<CanvasSyncStatusResponse>;
      })
      .then((data) => {
        setStatus(data);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        setStatusError((err as Error).message);
      })
      .finally(dispose);
  }, [courseId]);

  useEffect(() => {
    if (credential) loadStatus();
  }, [credential, loadStatus]);

  const loadCourseOptions = useCallback(async () => {
    setLoadingCourseOptions(true);
    setCourseOptionsError(null);
    announce("Loading Canvas courses…");
    const { signal, dispose } = abortAfter(20_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/courses`, { signal });
      if (!res.ok) throw new Error(await errorMessageFor(res, "Could not load your Canvas courses."));
      const data = (await res.json()) as { courses: CanvasCourseOption[] };
      setCourseOptions(data.courses);
      announce(
        data.courses.length === 1 ? "1 Canvas course found." : `${data.courses.length} Canvas courses found.`,
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setCourseOptionsError((err as Error).message);
    } finally {
      setLoadingCourseOptions(false);
      dispose();
    }
  }, [courseId, announce]);

  const linkCourse = useCallback(async () => {
    if (!selectedCanvasCourseId) return;
    setLinking(true);
    announce("Linking this Canvas course…");
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/link`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ canvasCourseId: selectedCanvasCourseId }),
        signal,
      });
      if (!res.ok) {
        const message = await errorMessageFor(res, "Could not link that course.");
        setCourseOptionsError(message);
        announce(message);
        return;
      }
      setCourseOptions(null);
      setSyncResult(null);
      announce("Course linked to Canvas.");
      loadStatus();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      announce("Could not link that course. Please try again.");
    } finally {
      setLinking(false);
      dispose();
    }
  }, [courseId, selectedCanvasCourseId, announce, loadStatus]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    announce("Syncing roster from Canvas — this can take a moment for a large course…");
    // A full-course sync (fetch every page of enrollments, then write) can
    // genuinely run long; this ceiling is generous rather than tight, so a
    // real sync isn't mistaken for a hang.
    const { signal, dispose } = abortAfter(60_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/sync`, { method: "POST", signal });
      if (!res.ok) {
        const message = await errorMessageFor(res, "The sync could not complete.");
        announce(message);
        loadStatus();
        return;
      }
      const data = (await res.json()) as CanvasSyncResponse;
      setSyncResult(data);
      announce(
        `Sync complete: ${data.added} added, ${data.updated} updated, ${data.removed} removed` +
          (data.errors.length > 0 ? `, ${data.errors.length} could not be synced.` : "."),
      );
      loadStatus();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      announce("The sync could not complete. Please try again.");
    } finally {
      setSyncing(false);
      dispose();
    }
  }, [courseId, announce, loadStatus]);

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="CANVAS INTEGRATION"
        title={`Canvas · ${courseTitle}`}
        subtitle="Connect this organization's Canvas account and keep a course roster in sync from it."
      />

      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      <section aria-labelledby="canvas-token-heading">
        <h2 id="canvas-token-heading">Canvas API token</h2>

        {credentialError && (
          <div className="admin-alert" role="alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>{credentialError}</span>
          </div>
        )}

        {credential === undefined ? (
          <p>Loading…</p>
        ) : credential && !editingCredential ? (
          <div className="admin-form-field">
            <p>
              <strong>{credential.maskedToken}</strong> — {credential.canvasBaseUrl}
            </p>
            <p className="admin-form-hint">
              {credential.rotatedAt
                ? `Last entered ${new Date(credential.rotatedAt).toLocaleDateString()}.`
                : "No entry date on file."}{" "}
              Canvas tokens are typically good for about a quarter — re-enter it here once it expires.
            </p>
            {validation && (
              <p className={validation.ok ? "admin-form-hint" : "admin-field-error"}>
                {validation.ok && (
                  <CheckCircle size={14} weight="fill" aria-hidden="true" style={{ marginRight: 4 }} />
                )}
                {validation.message}
              </p>
            )}
            <div className="admin-form-actions admin-form-actions--inline">
              <button
                type="button"
                className="admin-button"
                onClick={validateCredential}
                disabled={validating}
              >
                {validating ? "Validating…" : "Validate"}
              </button>
              <button
                type="button"
                className="admin-button admin-button--ghost"
                onClick={() => {
                  setEditingCredential(true);
                  setTokenInput("");
                  setValidation(null);
                }}
              >
                Replace token
              </button>
              <button
                type="button"
                className="admin-link-button admin-link-button--danger"
                onClick={deleteCredential}
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <form className="admin-form" onSubmit={saveCredential} noValidate>
            <div className="admin-form-field">
              <label htmlFor="canvas-base-url">Canvas instance URL</label>
              <input
                id="canvas-base-url"
                type="url"
                required
                placeholder="https://uw.instructure.com"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
              />
            </div>
            <div className="admin-form-field">
              <label htmlFor="canvas-token">API token</label>
              <input
                id="canvas-token"
                type="password"
                required
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <p className="admin-form-hint">
                Generate one in Canvas under Account → Settings → New Access Token. This app stores it
                encrypted and never displays it again in full.
              </p>
            </div>
            <div className="admin-form-actions">
              <button type="submit" className="admin-button admin-button--primary" disabled={savingCredential}>
                {savingCredential ? "Saving…" : "Save token"}
              </button>
              {credential && (
                <button
                  type="button"
                  className="admin-button admin-button--ghost"
                  onClick={() => setEditingCredential(false)}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      {credential && (
        <section aria-labelledby="canvas-sync-heading">
          <h2 id="canvas-sync-heading">Course roster sync</h2>

          {statusError && (
            <div className="admin-alert" role="alert">
              <span className="admin-alert__icon" aria-hidden="true">
                <Warning size={16} weight="regular" />
              </span>
              <span>{statusError}</span>
            </div>
          )}

          {status?.canvasCourseId ? (
            <div className="admin-form-field">
              <p>
                Linked to Canvas course <strong>{status.canvasCourseId}</strong>.
              </p>
              <p className="admin-form-hint">
                {status.lastSyncedAt
                  ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}.`
                  : "Never synced yet."}{" "}
                {status.lastSyncCounts &&
                  `Last run: ${status.lastSyncCounts.added} added, ${status.lastSyncCounts.updated} updated, ${status.lastSyncCounts.removed} removed.`}
              </p>
              {status.lastSyncStatus === "error" && status.lastSyncErrorMessage && (
                <p className="admin-field-error">{status.lastSyncErrorMessage}</p>
              )}

              <div className="admin-form-actions">
                <button
                  type="button"
                  className="admin-button admin-button--primary"
                  onClick={runSync}
                  disabled={syncing}
                >
                  <CloudArrowDown size={14} weight="regular" aria-hidden="true" style={{ marginRight: 4 }} />
                  {syncing ? "Syncing…" : "Sync from Canvas"}
                </button>
                <button
                  type="button"
                  className="admin-button admin-button--ghost"
                  onClick={loadCourseOptions}
                  disabled={loadingCourseOptions}
                >
                  Change linked course
                </button>
              </div>

              {syncResult && (
                <div className="admin-form-hint" role="status">
                  <p>
                    {syncResult.added} added, {syncResult.updated} updated, {syncResult.removed} removed.
                  </p>
                  {syncResult.errors.length > 0 && (
                    <ul>
                      {syncResult.errors.map((e) => (
                        <li key={e.canvasEnrollmentId}>{e.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p>This course is not linked to a Canvas course yet.</p>
          )}

          {courseOptionsError && (
            <div className="admin-alert" role="alert">
              <span className="admin-alert__icon" aria-hidden="true">
                <Warning size={16} weight="regular" />
              </span>
              <span>{courseOptionsError}</span>
            </div>
          )}

          {!status?.canvasCourseId && courseOptions === null && (
            <button
              type="button"
              className="admin-button"
              onClick={loadCourseOptions}
              disabled={loadingCourseOptions}
            >
              {loadingCourseOptions ? "Loading…" : "Link a Canvas course"}
            </button>
          )}

          {courseOptions !== null && (
            <div className="admin-form-field">
              {courseOptions.length === 0 ? (
                <p>No courses were found under this Canvas account. This token's owner may not teach any.</p>
              ) : (
                <>
                  <label htmlFor="canvas-course-select">Canvas course</label>
                  <select
                    id="canvas-course-select"
                    value={selectedCanvasCourseId}
                    onChange={(e) => setSelectedCanvasCourseId(e.target.value)}
                  >
                    <option value="">Choose a course…</option>
                    {courseOptions.map((option) => (
                      <option key={option.canvasCourseId} value={option.canvasCourseId}>
                        {option.name}
                        {option.courseCode ? ` (${option.courseCode})` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="admin-form-actions">
                    <button
                      type="button"
                      className="admin-button admin-button--primary"
                      onClick={linkCourse}
                      disabled={!selectedCanvasCourseId || linking}
                    >
                      {linking ? "Linking…" : "Link this course"}
                    </button>
                    <button
                      type="button"
                      className="admin-button admin-button--ghost"
                      onClick={() => setCourseOptions(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
