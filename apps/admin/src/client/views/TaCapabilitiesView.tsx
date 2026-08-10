/* --------------------------------------------------------------------------
   TaCapabilitiesView — per-course TA capability grants (#172).

   A TA's console access is deliberately narrow by default: they can read the
   submissions dashboard and individual student answers, but cannot author
   content, and cannot see model solutions or unreleased (draft/scheduled/
   hidden) homeworks unless an instructor grants it here, course by course.

   Instructor-only. The backing endpoints are requireInstructorOf, so this
   view is never rendered for a TA -- App.tsx gates the nav entry and the
   route on canAuthor. An earlier version accepted a `canAuthor` prop and
   rendered read-only toggles for a TA; that path was unreachable (the list
   fetch 403s before anything renders) and produced the exact defect #172
   exists to remove: a console surface offering an action that always fails.

   Local types mirror apps/web's CourseTaCapabilitiesResponse -- apps/admin
   never imports from apps/web, same convention as SubmissionsView.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";

export interface TaCapabilities {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

type CapabilityField = "canViewSolutions" | "canViewDrafts";

/** Column copy names the homework statuses the grant actually covers, in the
 *  instructor's own vocabulary (#172 audit, USE-005). "Unreleased" appears
 *  nowhere in HomeworksView's status labels, so an instructor could not tell
 *  whether a scheduled or hidden homework was included. */
const CAPABILITY_COLUMNS: { field: CapabilityField; label: string; help: string }[] = [
  {
    field: "canViewSolutions",
    label: "Model solutions",
    help: "Can open the Solution on every section of every homework in this course.",
  },
  {
    field: "canViewDrafts",
    label: "Unreleased homeworks",
    help: "Can open homeworks in draft, scheduled, or hidden status.",
  },
];

/** Runtime-validated rather than cast (#172 audit, CMP-005). A wrong-shaped
 *  row would otherwise render a checkbox with `checked={undefined}` — React
 *  flips it to uncontrolled and the next toggle PATCHes a value the user was
 *  never actually shown. */
function parseTa(raw: unknown): TaCapabilities | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.membershipId !== "string" || typeof t.userId !== "string") return null;
  if (typeof t.canViewSolutions !== "boolean" || typeof t.canViewDrafts !== "boolean") return null;
  return {
    membershipId: t.membershipId,
    userId: t.userId,
    displayName: typeof t.displayName === "string" ? t.displayName : "",
    email: typeof t.email === "string" ? t.email : "",
    canViewSolutions: t.canViewSolutions,
    canViewDrafts: t.canViewDrafts,
  };
}

/** Surfaces the server's own message when it sent one, so a 404 ("this TA
 *  may have been removed") isn't reported as "please try again" — advice
 *  that would never succeed (#172 audit, USE-003). */
async function errorMessageFor(res: Response): Promise<string> {
  let serverMessage = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") serverMessage = body.error;
  } catch {
    /* non-JSON body — fall through to the status-based advice */
  }
  if (res.status === 404) {
    return `${serverMessage || "That teaching assistant was not found."} They may have been removed from this course.`;
  }
  if (res.status === 403) return "Your permissions changed. Reload the console.";
  if (res.status >= 500) return "Could not update that permission. Please try again.";
  return serverMessage || "Could not update that permission.";
}

export function TaCapabilitiesView({ courseId }: { courseId: string }) {
  const [tas, setTas] = useState<TaCapabilities[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<{ membershipId: string; message: string } | null>(null);
  /** A set, not a single id: one in-flight save must not re-enable a
   *  different row still saving (#172 audit, REL-004). */
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  /** Announced politely so a screen reader learns the save landed; the region
   *  is mounted for the view's lifetime, since conditionally mounting a live
   *  region is the pattern that silently fails to announce (ACC-004). */
  const [liveMessage, setLiveMessage] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    setTas(null);
    setLoadError(false);
    fetch(`/api/courses/${courseId}/tas`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => {
        if (!r.ok) throw new Error(`failed: ${r.status}`);
        return r.json() as Promise<{ tas: unknown }>;
      })
      .then((data) => {
        const rows = Array.isArray(data.tas) ? data.tas : [];
        setTas(rows.map(parseTa).filter((t): t is TaCapabilities => t !== null));
      })
      .catch(() => setLoadError(true));
  }, [courseId]);

  useEffect(() => {
    load();
    const controller = new AbortController();
    abortRef.current = controller;
    // Aborts any in-flight PATCH when the course changes or the view
    // unmounts, so a resolved save can't write state into a different
    // course's roster (#172 audit, REL-005).
    return () => controller.abort();
  }, [load]);

  const toggle = useCallback(
    async (ta: TaCapabilities, field: CapabilityField) => {
      if (savingIds.has(ta.membershipId)) return;
      const next = !ta[field];
      const column = CAPABILITY_COLUMNS.find((c) => c.field === field)!;
      const who = ta.displayName || ta.email || ta.userId;

      setSavingIds((prev) => new Set(prev).add(ta.membershipId));
      setSaveError(null);
      setLiveMessage(`Saving ${column.label} for ${who}…`);
      try {
        const res = await fetch(`/api/courses/${courseId}/tas/${ta.membershipId}/capabilities`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [field]: next }),
          signal: abortRef.current?.signal,
        });
        if (!res.ok) {
          const message = await errorMessageFor(res);
          setSaveError({ membershipId: ta.membershipId, message });
          setLiveMessage(message);
          // A 404 means the row is stale — refetch so it stops being offered.
          if (res.status === 404) load();
          return;
        }
        const updated = parseTa({ ...ta, ...((await res.json()) as object) });
        if (!updated) {
          const message = "The server returned an unexpected response. Reload the console.";
          setSaveError({ membershipId: ta.membershipId, message });
          setLiveMessage(message);
          return;
        }
        setTas((prev) =>
          prev ? prev.map((t) => (t.membershipId === updated.membershipId ? updated : t)) : prev,
        );
        setLiveMessage(
          `${column.label} ${updated[field] ? "allowed" : "not allowed"} for ${who}.`,
        );
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message = "Could not update that permission. Please try again.";
        setSaveError({ membershipId: ta.membershipId, message });
        setLiveMessage(message);
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(ta.membershipId);
          return next;
        });
      }
    },
    [courseId, load, savingIds],
  );

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="TEACHING ASSISTANTS"
        title="TA permissions"
        subtitle="TAs can always read the submissions dashboard and student answers. Model solutions and unreleased homeworks are granted per course."
      />

      {/* Mounted unconditionally so announcements are reliable (ACC-004). */}
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        {liveMessage}
      </div>

      {loadError ? (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>
            Failed to load teaching assistants for this course.{" "}
            <button type="button" className="admin-link-button" onClick={load}>
              Retry
            </button>
          </span>
        </div>
      ) : !tas ? (
        <p role="status">Loading teaching assistants…</p>
      ) : tas.length === 0 ? (
        <div className="admin-empty">
          <Users size={22} weight="regular" aria-hidden="true" />
          <p>No teaching assistants are assigned to this course yet.</p>
        </div>
      ) : (
        // A real table: rows are TAs, columns are capabilities, so row/column
        // relationships are programmatically determinable and the header is
        // exposed rather than aria-hidden (ACC-005).
        <table className="admin-table">
          <caption className="admin-visually-hidden">
            Teaching assistant permissions for this course
          </caption>
          <thead>
            <tr>
              <th scope="col">Teaching assistant</th>
              {CAPABILITY_COLUMNS.map((c) => (
                <th key={c.field} scope="col">
                  {c.label}
                  <span className="admin-table__help">{c.help}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tas.map((ta) => {
              const saving = savingIds.has(ta.membershipId);
              const rowError = saveError?.membershipId === ta.membershipId ? saveError : null;
              const errorId = `ta-error-${ta.membershipId}`;
              return (
                <tr key={ta.membershipId} aria-busy={saving || undefined}>
                  <th scope="row">
                    <span className="admin-submission-row__name-label">
                      {ta.displayName || "(no name on file)"}
                    </span>
                    <span className="admin-submission-row__name-id">{ta.email}</span>
                    {rowError && (
                      <span id={errorId} className="admin-field-error">
                        {rowError.message}
                      </span>
                    )}
                  </th>
                  {CAPABILITY_COLUMNS.map((c) => (
                    <td key={c.field}>
                      <label className="admin-toggle">
                        <input
                          type="checkbox"
                          checked={ta[c.field]}
                          // Deliberately NOT disabled while saving: disabling
                          // the focused control blurs it and drops the
                          // keyboard user out of the row (ACC-002). Re-entry
                          // is guarded in `toggle` instead.
                          aria-label={`${c.label} for ${ta.displayName || ta.email || ta.userId}`}
                          aria-invalid={rowError ? true : undefined}
                          aria-errormessage={rowError ? errorId : undefined}
                          onChange={() => toggle(ta, c.field)}
                        />
                        <span className="admin-toggle__label">
                          {saving ? "Saving…" : ta[c.field] ? "Allowed" : "Not allowed"}
                        </span>
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
