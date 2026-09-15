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

/** #73: "show expiry state" -- turns the raw expiresAt into the sentence
 *  an instructor actually needs: whether it's already past, coming up
 *  soon (re-entry is a known quarterly chore, so this is a nudge rather
 *  than a countdown), or simply not set. */
function expiryStateText(expiresAt: string | null): { text: string; overdue: boolean } {
  if (!expiresAt) return { text: "No expiry date on file.", overdue: false };
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const date = new Date(expiresAt).toLocaleDateString();
  if (days < 0) return { text: `Expired ${date}.`, overdue: true };
  if (days <= 14) return { text: `Expires ${date} — replace it soon.`, overdue: true };
  return { text: `Expires ${date}.`, overdue: false };
}

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

/** #6 (accessibility review, PR #457, ACC-003): this view's own error
 *  messages come back as one page-level string, not a field-scoped
 *  response the server tags -- so the field to mark aria-invalid is
 *  inferred from which of THIS form's own fixed, known validation
 *  sentences the message matches (parseCanvasBaseUrl/setCanvasCredentialHandler,
 *  canvasCredentials.ts). Returns null rather than guessing wrong when a
 *  message doesn't match any of them (a network failure, a 5xx) -- an
 *  unmatched error stays page-level only, which is correct: it isn't
 *  about a specific field's content. */
function fieldForCredentialError(message: string): "canvas-base-url" | "canvas-token" | "canvas-token-expiry" | null {
  const lower = message.toLowerCase();
  if (lower.includes("url") || lower.includes("canvas instance")) return "canvas-base-url";
  if (lower.includes("token")) return "canvas-token";
  if (lower.includes("expiry") || lower.includes("date")) return "canvas-token-expiry";
  return null;
}

export function CanvasIntegrationView({
  courseId,
  // Unused for now -- the page header dropped the per-course title
  // suffix (`Canvas · ${courseTitle}`) since the only course in this
  // console today is seed data, not something an instructor picked.
  // Kept in the prop type rather than removed so restoring it later (once
  // there's a real multi-course picker) is a one-line change here, not a
  // signature change at the call site too.
  courseTitle: _courseTitle,
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

  // #3 (accessibility review, PR #457, ACC-020): six state transitions in
  // this view swap which DOM block is rendered (the token card <-> the
  // token form, the "link a course" button <-> the picker <-> the linked-
  // course view) -- each one, unguided, drops keyboard/screen-reader focus
  // to <body>. `focusTargetRef` names where focus should land after the
  // NEXT render reflects a transition; a plain no-dependency-array effect
  // (the same "runs after every render, no-ops when nothing is pending"
  // shape as this view's other one-shot effects) applies and clears it.
  // Mirrors TaCapabilitiesView's own restoreFocusTo pattern, simplified
  // for this view's single-target (not per-row) shape.
  type FocusTarget =
    | "credential-base-url"
    | "credential-replace-button"
    | "credential-validate-button"
    | "link-course-button"
    | "course-select"
    | "sync-button";
  const focusTargetRef = useRef<FocusTarget | null>(null);
  const baseUrlInputRef = useRef<HTMLInputElement>(null);
  const replaceButtonRef = useRef<HTMLButtonElement>(null);
  const validateButtonRef = useRef<HTMLButtonElement>(null);
  const linkCourseButtonRef = useRef<HTMLButtonElement>(null);
  const courseSelectRef = useRef<HTMLSelectElement>(null);
  const syncButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    const refs: Record<FocusTarget, React.RefObject<HTMLElement | null>> = {
      "credential-base-url": baseUrlInputRef,
      "credential-replace-button": replaceButtonRef,
      "credential-validate-button": validateButtonRef,
      "link-course-button": linkCourseButtonRef,
      "course-select": courseSelectRef,
      "sync-button": syncButtonRef,
    };
    refs[target].current?.focus();
  });

  // ---- Section 1: the org's Canvas token ----
  const [credential, setCredential] = useState<CanvasCredentialSummary | null | undefined>(undefined);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  // #2 (usability review, PR #457): a transient network blip on
  // loadCredential previously set `credential` to null on ANY failure,
  // which this view's own render logic reads as "no token on file" and
  // shows the blank entry form -- the org's real token is still saved,
  // but the recovery path offered (re-enter it from scratch) is both
  // wrong and needlessly destructive-feeling. This flag keeps `credential`
  // truly unknown on a load failure so the credentialError banner (with a
  // Retry action) renders instead of the entry form.
  const [credentialLoadFailed, setCredentialLoadFailed] = useState(false);
  const [editingCredential, setEditingCredential] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("https://");
  // #73: "expiry metadata... show expiry state." An empty string, not
  // undefined -- a controlled <input type="date"> needs a string value on
  // every render, and "" is what clears back to "no expiry recorded."
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [savingCredential, setSavingCredential] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);
  // #4 (accessibility review, PR #457, ACC-002): plain refs, not state --
  // these guard re-entry inside the handlers below (see saveCredential/
  // deleteCredential) instead of `disabled` on the button, which is the
  // established fix in this codebase for the same lesson (disabling a
  // focused control blurs it and drops a keyboard user). No render needs
  // to react to these directly; the button's own label text (e.g.
  // "Saving…") is the visible in-flight signal.
  const deletingCredentialRef = useRef(false);

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
        setCredentialLoadFailed(false);
        if (data.credential) setBaseUrlInput(data.credential.canvasBaseUrl);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        const message = (err as Error).message || "Could not load Canvas token settings.";
        setCredentialError(message);
        setCredentialLoadFailed(true);
        announce(message);
      })
      .finally(dispose);
  }, [courseId, announce]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    loadCredential();
    return () => controller.abort();
  }, [loadCredential]);

  // Declared before saveCredential (below), which calls this directly
  // after a successful save (#9) -- kept in saveCredential's own
  // dependency array, so it needs to already be initialized by then.
  const validateCredential = useCallback(async () => {
    // #4 (accessibility review, PR #457, ACC-002): re-entry guard, not
    // `disabled` -- see deletingCredentialRef's own comment above.
    if (validating) {
      announce("Still validating — please wait.");
      return;
    }
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
      const message =
        (err as Error)?.name === "TimeoutError"
          ? "Validating is taking longer than expected. Please try again."
          : "Could not reach Canvas. Please try again.";
      setValidation({ ok: false, message });
      announce(message);
    } finally {
      setValidating(false);
      dispose();
    }
  }, [courseId, validating, announce]);

  const saveCredential = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      // #4 (accessibility review, PR #457, ACC-002): re-entry guard
      // instead of `disabled` on the submit button -- see this view's own
      // deletingCredentialRef comment above for why.
      if (savingCredential) {
        announce("Still saving the Canvas token — please wait.");
        return;
      }
      setSavingCredential(true);
      setCredentialError(null);
      announce("Saving Canvas token…");
      const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
      try {
        const res = await fetch(`/api/courses/${courseId}/canvas/credential`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: tokenInput,
            canvasBaseUrl: baseUrlInput,
            expiresAt: expiresAtInput || null,
          }),
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
        // #3: the form is about to unmount; the card's Validate button is
        // the next natural landing spot.
        focusTargetRef.current = "credential-validate-button";
        // #9 (usability review, PR #457): nothing previously prompted a
        // check after save, so a mistyped/invalid token "saved
        // successfully" with no on-card indication it had never actually
        // been confirmed against Canvas. Firing this here (not awaited --
        // the save itself already succeeded, and a slow/failing validate
        // call must not block the save from completing) surfaces that
        // immediately instead of leaving it for the instructor to
        // remember to click Validate themselves.
        void validateCredential();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message = "Could not save that token. Please try again.";
        setCredentialError(message);
        announce(message);
      } finally {
        setSavingCredential(false);
        dispose();
      }
    },
    [courseId, tokenInput, baseUrlInput, expiresAtInput, savingCredential, announce, validateCredential],
  );

  const deleteCredential = useCallback(async () => {
    // #4 (accessibility review, PR #457, ACC-002): re-entry guard, not
    // `disabled` -- see deletingCredentialRef's own comment above.
    if (deletingCredentialRef.current) {
      announce("Still removing the Canvas token — please wait.");
      return;
    }
    // #10 (usability review, PR #457): the previous wording never stated
    // the blast radius (org-wide, not just this course) or the undo path.
    // Matches this codebase's own confirm-dialog convention elsewhere
    // (StudentsView/TaCapabilitiesView): name the subject, state the
    // consequence, state what's preserved, state the undo path.
    const confirmed = window.confirm(
      "Remove this organization's Canvas token?\n\n" +
        "This token is shared by every course in your organization that syncs from Canvas -- " +
        "ALL of them stop being able to sync the moment it's removed, not just this course. " +
        "Rosters already synced are kept; no one loses access because of this. " +
        "Enter a new token any time to restore syncing everywhere.",
    );
    if (!confirmed) return;
    deletingCredentialRef.current = true;
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
      // #3: the card is about to unmount in favor of the entry form.
      focusTargetRef.current = "credential-base-url";
    } catch (err) {
      // #7 (usability/reliability review, PR #457): a real component
      // teardown aborts with reason.name "AbortError" (the parent
      // lifecycle signal's default); abortAfter's own timeout aborts with
      // "TimeoutError" (abortAfter.ts) and must still surface visibly --
      // announce() alone reaches only a screen reader's live region, so a
      // sighted instructor saw the button reset with zero signal anything
      // happened, and the only reasonable next move was to click it
      // again, which is exactly how #6's sync race gets triggered.
      if ((err as Error)?.name === "AbortError") return;
      const message = "Could not remove that token. Please try again.";
      setCredentialError(message);
      announce(message);
    } finally {
      deletingCredentialRef.current = false;
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
  const [syncError, setSyncError] = useState<string | null>(null);

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
        const message = (err as Error).message;
        setStatusError(message);
        announce(message);
      })
      .finally(dispose);
  }, [courseId, announce]);

  useEffect(() => {
    if (credential) loadStatus();
  }, [credential, loadStatus]);

  const loadCourseOptions = useCallback(async () => {
    // #4 (accessibility review, PR #457, ACC-002): re-entry guard, not
    // `disabled` -- see deletingCredentialRef's own comment above.
    if (loadingCourseOptions) {
      announce("Still loading Canvas courses — please wait.");
      return;
    }
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
      // #3: the picker's own select is the next natural landing spot.
      focusTargetRef.current = "course-select";
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      const message = (err as Error).message;
      setCourseOptionsError(message);
      announce(message);
    } finally {
      setLoadingCourseOptions(false);
      dispose();
    }
  }, [courseId, loadingCourseOptions, announce]);

  const linkCourse = useCallback(async () => {
    if (!selectedCanvasCourseId) return;
    // #4 (accessibility review, PR #457, ACC-002): re-entry guard, not
    // `disabled` -- see deletingCredentialRef's own comment above.
    if (linking) {
      announce("Still linking this course — please wait.");
      return;
    }
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
      // #3: the picker is about to unmount in favor of the linked-course
      // view; its Sync button is the next natural landing spot.
      focusTargetRef.current = "sync-button";
      loadStatus();
    } catch (err) {
      // #7: see deleteCredential's catch above for why this must not be
      // announce()-only.
      if ((err as Error)?.name === "AbortError") return;
      const message = "Could not link that course. Please try again.";
      setCourseOptionsError(message);
      announce(message);
    } finally {
      setLinking(false);
      dispose();
    }
  }, [courseId, selectedCanvasCourseId, linking, announce, loadStatus]);

  const runSync = useCallback(async () => {
    // #4 (accessibility review, PR #457, ACC-002): re-entry guard, not
    // `disabled` -- see deletingCredentialRef's own comment above. Backed
    // up server-side by #6's own atomic claim (lmsIntegrations.ts's
    // beginSync), which is the load-bearing guard; this one just stops
    // the instructor's own double-click from ever reaching it.
    if (syncing) {
      announce("Still syncing — please wait.");
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    announce("Syncing roster from Canvas — this can take a moment for a large course…");
    // A full-course sync (fetch every page of enrollments, then write) can
    // genuinely run long; this ceiling is generous rather than tight, so a
    // real sync isn't mistaken for a hang. Aborting here only cancels the
    // CLIENT's fetch -- the server-side sync keeps running -- which is
    // exactly why this catch must leave a visible, actionable trace
    // rather than silently resetting the button (#7 below).
    const { signal, dispose } = abortAfter(60_000, abortRef.current?.signal ?? null);
    try {
      const res = await fetch(`/api/courses/${courseId}/canvas/sync`, { method: "POST", signal });
      if (!res.ok) {
        const message = await errorMessageFor(res, "The sync could not complete.");
        setSyncError(message);
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
      // #7 (usability/reliability review, PR #457): the previous version
      // of this catch called announce() only -- a sighted instructor saw
      // the button flip back to "Sync from Canvas" with no visible signal
      // anything went wrong, and the only reasonable next move was to
      // click it again while the FIRST sync might still be running
      // server-side -- precisely what #6's concurrency guard now refuses,
      // but a clear error here is what stops the instructor from hitting
      // it in the first place.
      if ((err as Error)?.name === "AbortError") return;
      const message =
        (err as Error)?.name === "TimeoutError"
          ? "The sync is taking longer than expected. It may still be running -- check back shortly, or try again once it finishes."
          : "The sync could not complete. Please try again.";
      setSyncError(message);
      announce(message);
      loadStatus();
    } finally {
      setSyncing(false);
      dispose();
    }
  }, [courseId, syncing, announce, loadStatus]);

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="CANVAS INTEGRATION"
        title="Canvas"
        subtitle="Connect this organization's Canvas account and keep a course roster in sync from it."
      />

      {/* #5 (accessibility review, PR #457, ACC-004): the ONE always-mounted
          live region for this view. Every conditionally-mounted banner
          below deliberately carries no role="alert"/role="status" -- a
          region inserted into the DOM already containing its text doesn't
          reliably announce, the same lesson TaCapabilitiesView's own
          loadError already documents. Routing every announcement through
          this single channel is also what avoids ACC-025's double-announce
          (a banner AND a live region both speaking the same event). */}
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      <section aria-labelledby="canvas-token-heading">
        <h2 id="canvas-token-heading">Canvas API token</h2>

        {credentialError && (
          <div className="admin-alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>{credentialError}</span>
            {/* #2 (usability review, PR #457): a load failure is a
                transient-network-blip default, not "you need to start
                over" -- Retry re-runs the same load rather than routing
                into the destructive-feeling blank entry form below. */}
            {credentialLoadFailed && (
              <button type="button" className="admin-link-button" onClick={loadCredential} style={{ marginLeft: 8 }}>
                Retry
              </button>
            )}
          </div>
        )}

        {credential === undefined && !credentialLoadFailed ? (
          <p>Loading…</p>
        ) : credentialLoadFailed ? null : credential && !editingCredential ? (
          <div className="admin-form-field">
            <p>
              <strong>{credential.maskedToken}</strong> — {credential.canvasBaseUrl}
            </p>
            <p className="admin-form-hint">
              {credential.rotatedAt
                ? `Last entered ${new Date(credential.rotatedAt).toLocaleDateString()}.`
                : "No entry date on file."}
            </p>
            {(() => {
              const expiry = expiryStateText(credential.expiresAt);
              return (
                <p className={expiry.overdue ? "admin-field-error" : "admin-form-hint"}>
                  {expiry.overdue && <Warning size={14} weight="regular" aria-hidden="true" style={{ marginRight: 4 }} />}
                  {expiry.text}
                </p>
              );
            })()}
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
                ref={validateButtonRef}
                type="button"
                className="admin-button"
                onClick={validateCredential}
              >
                {validating ? "Validating…" : "Validate"}
              </button>
              <button
                ref={replaceButtonRef}
                type="button"
                className="admin-button admin-button--ghost"
                onClick={() => {
                  setEditingCredential(true);
                  setTokenInput("");
                  setExpiresAtInput(credential.expiresAt ? credential.expiresAt.slice(0, 10) : "");
                  setValidation(null);
                  // #3: the card is about to unmount in favor of the form.
                  focusTargetRef.current = "credential-base-url";
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
                ref={baseUrlInputRef}
                id="canvas-base-url"
                type="url"
                required
                placeholder="https://canvas.uw.edu"
                aria-describedby={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-base-url"
                    ? "canvas-base-url-hint canvas-base-url-error"
                    : "canvas-base-url-hint"
                }
                aria-invalid={credentialError && fieldForCredentialError(credentialError) === "canvas-base-url" ? "true" : undefined}
                aria-errormessage={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-base-url"
                    ? "canvas-base-url-error"
                    : undefined
                }
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
              />
              {/* #6 (accessibility review, PR #457, ACC-003): both
                  aria-describedby AND aria-errormessage point here when
                  this field is the one the error applies to -- VoiceOver
                  does not implement aria-errormessage alone, the same
                  reason TaCapabilitiesView keeps both. The CSS this
                  activates (`input[aria-invalid="true"]`) already existed
                  in styles.css and was unused by this view. */}
              {credentialError && fieldForCredentialError(credentialError) === "canvas-base-url" && (
                <p className="admin-field-error" id="canvas-base-url-error">
                  {credentialError}
                </p>
              )}
              {/* A placeholder disappears the moment the field is focused, so
                  it can't be the only place this example lives -- an
                  instructor tabbing in and typing never sees it. */}
              <p className="admin-form-hint" id="canvas-base-url-hint">
                For example: <code>https://canvas.uw.edu</code> — the address bar URL when you're
                signed into Canvas, with no path after it.
              </p>
            </div>
            <div className="admin-form-field">
              <label htmlFor="canvas-token">API token</label>
              <input
                id="canvas-token"
                type="password"
                required
                autoComplete="off"
                aria-describedby={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-token"
                    ? "canvas-token-hint canvas-token-error"
                    : "canvas-token-hint"
                }
                aria-invalid={credentialError && fieldForCredentialError(credentialError) === "canvas-token" ? "true" : undefined}
                aria-errormessage={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-token"
                    ? "canvas-token-error"
                    : undefined
                }
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              {credentialError && fieldForCredentialError(credentialError) === "canvas-token" && (
                <p className="admin-field-error" id="canvas-token-error">
                  {credentialError}
                </p>
              )}
              <p className="admin-form-hint" id="canvas-token-hint">
                Generate one in Canvas under Account → Settings → New Access Token. This app stores it
                encrypted and never displays it again in full.
              </p>
            </div>
            <div className="admin-form-field">
              <label htmlFor="canvas-token-expiry">Expiry date (optional)</label>
              <input
                id="canvas-token-expiry"
                type="date"
                aria-describedby={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-token-expiry"
                    ? "canvas-token-expiry-hint canvas-token-expiry-error"
                    : "canvas-token-expiry-hint"
                }
                aria-invalid={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-token-expiry" ? "true" : undefined
                }
                aria-errormessage={
                  credentialError && fieldForCredentialError(credentialError) === "canvas-token-expiry"
                    ? "canvas-token-expiry-error"
                    : undefined
                }
                value={expiresAtInput}
                onChange={(e) => setExpiresAtInput(e.target.value)}
              />
              {credentialError && fieldForCredentialError(credentialError) === "canvas-token-expiry" && (
                <p className="admin-field-error" id="canvas-token-expiry-error">
                  {credentialError}
                </p>
              )}
              <p className="admin-form-hint" id="canvas-token-expiry-hint">
                Canvas tokens are typically good for about a quarter. Setting a date here shows a
                reminder above once it's close, so this doesn't fail silently.
              </p>
            </div>
            <div className="admin-form-actions">
              <button type="submit" className="admin-button admin-button--primary">
                {savingCredential ? "Saving…" : "Save token"}
              </button>
              {credential && (
                <button
                  type="button"
                  className="admin-button admin-button--ghost"
                  onClick={() => {
                    setEditingCredential(false);
                    // #3: the form is about to unmount in favor of the card.
                    focusTargetRef.current = "credential-replace-button";
                  }}
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
            <div className="admin-alert">
              <span className="admin-alert__icon" aria-hidden="true">
                <Warning size={16} weight="regular" />
              </span>
              <span>{statusError}</span>
            </div>
          )}

          {status?.canvasCourseId ? (
            <div className="admin-form-field">
              <p>
                {/* #8 (usability review, PR #457): the raw numeric Canvas
                    course id told an instructor teaching two sections
                    nothing about which one they'd linked -- the name
                    captured at link time (canvasSync.ts's own
                    linkCanvasCourseHandler) is the primary label now, with
                    the id kept as a secondary detail rather than dropped. */}
                Linked to Canvas course{" "}
                <strong>{status.canvasCourseName ?? status.canvasCourseId}</strong>
                {status.canvasCourseName && (
                  <span className="admin-form-hint"> (Canvas id {status.canvasCourseId})</span>
                )}
                .
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
                  ref={syncButtonRef}
                  type="button"
                  className="admin-button admin-button--primary"
                  onClick={runSync}
                >
                  <CloudArrowDown size={14} weight="regular" aria-hidden="true" style={{ marginRight: 4 }} />
                  {syncing ? "Syncing…" : "Sync from Canvas"}
                </button>
                <button
                  type="button"
                  className="admin-button admin-button--ghost"
                  onClick={loadCourseOptions}
                >
                  Change linked course
                </button>
              </div>

              {syncError && (
                <div className="admin-alert">
                  <span className="admin-alert__icon" aria-hidden="true">
                    <Warning size={16} weight="regular" />
                  </span>
                  <span>{syncError}</span>
                </div>
              )}

              {syncResult && (
                <div className="admin-form-hint">
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
            <div className="admin-alert">
              <span className="admin-alert__icon" aria-hidden="true">
                <Warning size={16} weight="regular" />
              </span>
              <span>{courseOptionsError}</span>
            </div>
          )}

          {!status?.canvasCourseId && courseOptions === null && (
            <button
              ref={linkCourseButtonRef}
              type="button"
              className="admin-button"
              onClick={loadCourseOptions}
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
                    ref={courseSelectRef}
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
                      disabled={!selectedCanvasCourseId}
                    >
                      {linking ? "Linking…" : "Link this course"}
                    </button>
                    <button
                      type="button"
                      className="admin-button admin-button--ghost"
                      onClick={() => {
                        setCourseOptions(null);
                        // #3: the picker is about to unmount in favor of
                        // the "Link a Canvas course" button.
                        focusTargetRef.current = "link-course-button";
                      }}
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
