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
import { abortAfter } from "../lib/abortAfter";
import type { TaCapabilityField } from "@llteacher/ui";

export interface TaCapabilities {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

/** #202 (#172 re-audit, MNT-028): aliased from @llteacher/ui, not re-typed.
 *  The file header's "apps/admin never imports from apps/web" convention does
 *  not apply -- this is the shared UI package, which App.tsx already imports
 *  from, and courseRole.ts derives TaCapabilityField from the same
 *  TA_CAPABILITY_FIELDS the server enforces with. A third hand-written copy in
 *  a third package is exactly what that derivation exists to prevent: rename
 *  canViewDrafts and every other layer updates and typechecks while this view
 *  keeps the old key and PATCHes a body the server 400s. */
type CapabilityField = TaCapabilityField;

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

/** Runtime-validated rather than cast (#172 audit). A wrong-shaped row would
 *  otherwise render a checkbox with `checked={undefined}` — React flips it to
 *  uncontrolled and the next toggle PATCHes a value the user was never
 *  actually shown.
 *
 *  (#200/MNT-026: this used to cite CMP-005, which is the SPA-shell 404 in
 *  server/index.ts — a different finding entirely. Citation dropped rather
 *  than guessed at; the reason above stands on its own.) */
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

/** The PATCH echo is a `TaCapabilityGrant`: the two flags plus the ids, and
 *  deliberately no identity (the server does not decrypt a name to answer a
 *  write). Validated on its own terms rather than by spreading it over the
 *  local row — `parseTa({ ...ta, ...response })` could not reject an empty
 *  or wrong-membership response, because every required field was already
 *  supplied by `ta`. The UI then re-rendered the *old* value and announced
 *  success (#172 audit, REL-012). */
type TaCapabilityGrant = Pick<TaCapabilities, "membershipId" | CapabilityField>;

function parseGrant(raw: unknown): TaCapabilityGrant | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.membershipId !== "string") return null;
  if (typeof g.canViewSolutions !== "boolean" || typeof g.canViewDrafts !== "boolean") return null;
  return {
    membershipId: g.membershipId,
    canViewSolutions: g.canViewSolutions,
    canViewDrafts: g.canViewDrafts,
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
    // #188 (#172 re-audit, USE-025): returned as-is, not concatenated with a
    // trailing sentence. The old form glued a fixed clause on with a bare
    // space, and since the server's body carried no terminal punctuation the
    // instructor read one run-on line ("...not found in this course They may
    // have been removed from this course."). The server now sends a complete
    // human sentence naming a person rather than a membership row, so the
    // client's job is to show it, not to repair it.
    return serverMessage || "That teaching assistant is no longer in this course.";
  }
  if (res.status === 403) return "Your permissions changed. Reload the console.";
  if (res.status >= 500) return "Could not update that permission. Please try again.";
  return serverMessage || "Could not update that permission.";
}

export function TaCapabilitiesView({
  courseId,
  courseTitle,
}: {
  courseId: string;
  /** #185 (#172 re-audit, USE-023). This page grants the answer key, and it
   *  used to name no course at all -- the only course string in the chrome is
   *  TopNav's hardcoded "STATS 311", while the course actually written to is
   *  `courses[0]`, chosen authority-first by ProfileService. An instructor
   *  with two courses could grant on one while the only visible label named
   *  the other, and nothing in the console would ever show them the mistake:
   *  the record of it lives in the server-side audit log. */
  courseTitle: string;
}) {
  const [tas, setTas] = useState<TaCapabilities[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  /** #194 (#172 re-audit, ACC-022): carries the FIELD as well as the
   *  membership. savingIds was re-keyed to `membershipId:field` for REL-015;
   *  the error state was left keyed by membership alone, so a failure saving
   *  Model solutions marked the Unreleased-homeworks checkbox on the same row
   *  aria-invalid and pointed its aria-errormessage at the other capability's
   *  error. A screen-reader user, told the drafts grant had failed, would
   *  press Space to retry it -- revoking a grant that was working. Fixing one
   *  instance of a keying bug and not the other is what made that reachable. */
  const [saveError, setSaveError] = useState<
    { membershipId: string; field: CapabilityField; message: string } | null
  >(null);
  /** Keyed `membershipId:field`, not by membership alone (#172 audit,
   *  REL-004 then REL-015). Two capabilities sit on the same row, so keying
   *  by membership made toggling Solutions block Drafts on that row, and
   *  showed "Saving…" under both checkboxes when only one was in flight. */
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const savingKey = (membershipId: string, field: CapabilityField) => `${membershipId}:${field}`;
  /** Announced politely so a screen reader learns the save landed; the region
   *  is mounted for the view's lifetime, since conditionally mounting a live
   *  region is the pattern that silently fails to announce (ACC-004). */
  const [liveMessage, setLiveMessage] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    setTas(null);
    setLoadError(false);
    // NOT setSaveError(null): a 404 on a save calls load() to drop the stale
    // row, and clearing the error here unmounted the only explanation the
    // instructor ever got. The refetched roster no longer contains that TA,
    // so the inline message had nowhere to render either -- the toggle
    // simply reverted with no stated reason (#172 audit, USE-010). The
    // orphan notice below is what keeps it on screen.
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal);
    fetch(`/api/courses/${courseId}/tas`, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`failed: ${r.status}`);
        return r.json() as Promise<{ tas: unknown }>;
      })
      .then((data) => {
        const rows = Array.isArray(data.tas) ? data.tas : [];
        setTas(
          rows
            .map(parseTa)
            .filter((t): t is TaCapabilities => t !== null)
            // #189 (#172 re-audit, USE-028): sorted by the name the
            // instructor actually reads. The server orders too, but only by
            // the ENCRYPTED email -- stable, and deliberately not
            // alphabetical, since ciphertext does not collate. The plaintext
            // exists only here, so this is the only place an instructor-
            // meaningful order can be produced.
            .sort((a, b) =>
              (a.displayName || a.email).localeCompare(b.displayName || b.email),
            ),
        );
      })
      .catch((err: unknown) => {
        // An unmount/course-change abort is not a load failure -- reporting
        // it would flash an error banner on the way out.
        if ((err as Error)?.name === "AbortError") return;
        setLoadError(true);
      })
      .finally(dispose);
  }, [courseId]);

  useEffect(() => {
    // Established before load() so the list fetch is covered by the same
    // lifecycle signal the PATCHes are (#172 audit, REL-005).
    const controller = new AbortController();
    abortRef.current = controller;
    load();
    return () => controller.abort();
  }, [load]);

  const toggle = useCallback(
    async (ta: TaCapabilities, field: CapabilityField) => {
      const key = savingKey(ta.membershipId, field);
      if (savingIds.has(key)) return;
      const next = !ta[field];
      const column = CAPABILITY_COLUMNS.find((c) => c.field === field)!;
      const who = ta.displayName || ta.email || ta.userId;

      setSavingIds((prev) => new Set(prev).add(key));
      setSaveError(null);
      setLiveMessage(`Saving ${column.label} for ${who}…`);
      // Composed, not `abortRef.current?.signal` alone: the lifecycle signal
      // has no timeout, so a PATCH against a hung Worker stayed pending
      // forever with the row stuck on "Saving…" and no way back except a
      // reload (#172 audit, REL-011).
      const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal);
      try {
        const res = await fetch(`/api/courses/${courseId}/tas/${ta.membershipId}/capabilities`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [field]: next }),
          signal,
        });
        if (!res.ok) {
          const message = await errorMessageFor(res);
          setSaveError({ membershipId: ta.membershipId, field, message });
          setLiveMessage(message);
          // A 404 means the row is stale — refetch so it stops being offered.
          if (res.status === 404) load();
          return;
        }
        const grant = parseGrant(await res.json());
        // The membership check is the point: a proxy or a mis-keyed handler
        // answering with a *different* TA's grant would otherwise be written
        // onto the row the instructor was actually editing.
        if (!grant || grant.membershipId !== ta.membershipId) {
          const message = "The server returned an unexpected response. Reload the console.";
          setSaveError({ membershipId: ta.membershipId, field, message });
          setLiveMessage(message);
          return;
        }
        // Identity comes from the row we already have -- the echo carries
        // only the flags, by design.
        const updated: TaCapabilities = {
          ...ta,
          canViewSolutions: grant.canViewSolutions,
          canViewDrafts: grant.canViewDrafts,
        };
        setTas((prev) =>
          prev ? prev.map((t) => (t.membershipId === ta.membershipId ? updated : t)) : prev,
        );
        setLiveMessage(
          `${column.label} ${updated[field] ? "allowed" : "not allowed"} for ${who}.`,
        );
      } catch (err) {
        const name = (err as Error)?.name;
        // The lifecycle abort means this component is going away; the
        // timeout means the request genuinely gave up and the instructor
        // needs to hear about it.
        if (name === "AbortError") return;
        const message =
          name === "TimeoutError"
            ? "That permission change timed out. It may not have been saved — reload to check."
            : "Could not update that permission. Please try again.";
        setSaveError({ membershipId: ta.membershipId, field, message });
        setLiveMessage(message);
      } finally {
        dispose();
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
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
        title={`TA permissions · ${courseTitle}`}
        // "for this course only" rather than "per course": the old wording
        // described the permission MODEL, which the instructor already
        // gathered, while leaving the thing they actually needed -- which
        // course this page writes to -- unstated (#185, USE-023).
        subtitle="TAs can always read the submissions dashboard and student answers. Model solutions and unreleased homeworks are granted for this course only."
      />

      {/* Mounted unconditionally so announcements are reliable (ACC-004). */}
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        {liveMessage}
      </div>

      {/* A save error whose row is no longer on screen -- because load() is
          refetching after a 404, or because the refetch confirmed the TA is
          gone. Rendered here, outside the roster conditional below, so the
          explanation outlives the row it was attached to (#172 audit,
          USE-010). */}
      {saveError && !tas?.some((t) => t.membershipId === saveError.membershipId) && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{saveError.message}</span>
        </div>
      )}

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
              const rowSaving = CAPABILITY_COLUMNS.some((c) =>
                savingIds.has(savingKey(ta.membershipId, c.field)),
              );
              const who = ta.displayName || ta.email || ta.userId;
              return (
                <tr key={ta.membershipId} aria-busy={rowSaving || undefined}>
                  <th scope="row">
                    <span className="admin-submission-row__name-label">
                      {ta.displayName || "(no name on file)"}
                    </span>
                    <span className="admin-submission-row__name-id">{ta.email}</span>
                  </th>
                  {CAPABILITY_COLUMNS.map((c) => {
                    const cellSaving = savingIds.has(savingKey(ta.membershipId, c.field));
                    // #194 (ACC-022): matched on membership AND field, so a
                    // failure on one capability leaves the other's checkbox
                    // valid and unassociated.
                    const cellError =
                      saveError?.membershipId === ta.membershipId && saveError.field === c.field
                        ? saveError
                        : null;
                    const errorId = `ta-error-${ta.membershipId}-${c.field}`;
                    // #195 (ACC-021): the visible text is computed once and
                    // used BOTH as the label the user reads and as the prefix
                    // of the accessible name. Voice Control and Dragon match
                    // on the accessible name, so a name that omitted the one
                    // word on screen ("Allowed") left the page's only control
                    // type unaddressable by voice.
                    const stateText = cellSaving
                      ? "Saving…"
                      : ta[c.field]
                        ? "Allowed"
                        : "Not allowed";
                    return (
                    <td key={c.field}>
                      <label className="admin-toggle">
                        <input
                          type="checkbox"
                          checked={ta[c.field]}
                          // Deliberately NOT disabled while saving: disabling
                          // the focused control blurs it and drops the
                          // keyboard user out of the row (ACC-002). Re-entry
                          // is guarded in `toggle` instead.
                          aria-label={`${stateText} — ${c.label} for ${who}`}
                          aria-invalid={cellError ? true : undefined}
                          // #204 (ACC-023): describedby ALONGSIDE errormessage,
                          // not instead of it. VoiceOver does not implement
                          // aria-errormessage at all, so it was the sole
                          // association on the one platform that ignores it.
                          aria-errormessage={cellError ? errorId : undefined}
                          aria-describedby={cellError ? errorId : undefined}
                          onChange={() => toggle(ta, c.field)}
                        />
                        <span className="admin-toggle__label">{stateText}</span>
                      </label>
                      {/* In the failing cell, not the row header (#204,
                          ACC-023): sitting in <th scope="row"> made every
                          cell traversal re-read the whole error sentence as
                          part of the row's name. */}
                      {cellError && (
                        <span id={errorId} className="admin-field-error">
                          {cellError.message}
                        </span>
                      )}
                    </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
