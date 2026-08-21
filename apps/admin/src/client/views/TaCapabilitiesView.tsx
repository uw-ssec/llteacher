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
import { AddTasPanel, type AddTaResult } from "../components/AddTasPanel";
import { PageHeader } from "../components/PageHeader";
import { abortAfter } from "../lib/abortAfter";

/** Mirrors MAX_TAS_PER_REQUEST in apps/web's route, so the form states the
 *  bound it will be held to rather than letting the instructor discover it
 *  as a 400 after pasting a long list. apps/admin never imports from
 *  apps/web, so this is the same deliberate duplication as the payload types
 *  above -- and the route test pins the server's number. */
const MAX_TAS_PER_REQUEST = 100;
import type { TaCapabilityField } from "@llteacher/ui";

export interface TaCapabilities {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  /** #210: added by NetID, never signed in. An instructor needs to tell
   *  "waiting for them to log in" apart from "something is wrong" -- before
   *  #210 nothing created a pending TA, so the distinction did not exist. */
  isPending: boolean;
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
 *  whether a scheduled or hidden homework was included.
 *
 *  #202 (MNT-028), second half: keyed by capability field and constrained
 *  with `satisfies Record<CapabilityField, ...>`, so adding or renaming a
 *  field in @llteacher/ui fails to compile here rather than quietly dropping
 *  a column from the only surface that grants it. An array of
 *  `{ field, label, help }` could not do that -- an array stays assignable
 *  while a member is missing.
 *
 *  Declaration order below is the column order, since the columns are
 *  derived from this object's keys. */
const CAPABILITY_COPY = {
  canViewSolutions: {
    label: "Model solutions",
    help: "Can open the Solution on every section of every homework in this course.",
  },
  canViewDrafts: {
    label: "Unreleased homeworks",
    help: "Can open homeworks in draft, scheduled, or hidden status.",
  },
} satisfies Record<CapabilityField, { label: string; help: string }>;

const CAPABILITY_COLUMNS: { field: CapabilityField; label: string; help: string }[] = (
  Object.keys(CAPABILITY_COPY) as CapabilityField[]
).map((field) => ({ field, ...CAPABILITY_COPY[field] }));

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
    // Absent on a pre-#210 server: read as false rather than dropping the
    // row, matching how AuthProvider degrades a missing field. "Not marked
    // pending" is the safe reading -- it claims nothing the payload did not.
    isPending: t.isPending === true,
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
 *  that would never succeed (#172 audit, USE-003).
 *
 *  #210: `fallback` names the action that failed. This page now performs two
 *  different writes against the same TA row, and the capability wording
 *  ("Could not update that permission") told an instructor whose *removal*
 *  failed that something else had gone wrong -- pointing them at the wrong
 *  control to retry. The 404 and 403 branches are shared deliberately: those
 *  two sentences are about the row and the session, not about which button
 *  was pressed. */
async function errorMessageFor(
  res: Response,
  fallback = "Could not update that permission.",
): Promise<string> {
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
  if (res.status >= 500) return `${fallback.replace(/\.$/, "")}. Please try again.`;
  return serverMessage || fallback;
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
   *  region is the pattern that silently fails to announce (ACC-004).
   *
   *  #204 (ACC-026): carries a monotonic nonce, and the region renders the
   *  text inside a `key={nonce}` child. Plain `announce(string)` bailed
   *  out by Object.is on an identical value, so the text node never mutated
   *  and an unchanged live region announces nothing. Several writers here
   *  emit fixed strings, so consecutive identical writes are reachable: two
   *  rows failing with the same generic message announced only the first,
   *  while the visible error *moved* to the second row. The screen reader
   *  and the screen then disagreed about which row had failed.
   *
   *  The nonce keys a child, never the region itself -- remounting the
   *  region is the ACC-004 defect. */
  const [live, setLive] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const announce = useCallback(
    (text: string) => setLive((prev) => ({ text, nonce: prev.nonce + 1 })),
    [],
  );
  const abortRef = useRef<AbortController | null>(null);
  /** #196 (#172 re-audit, ACC-020): focus survives a teardown.
   *
   *  A 404 save calls load(), whose first statement is setTas(null) -- which
   *  unmounts the whole <table>, including the checkbox the user is standing
   *  on. Nothing restored focus, so the browser dropped it to <body>: an NVDA
   *  user's virtual cursor reset to the top of the document and they had to
   *  tab back through the TopNav and the entire sidebar. The happy path is
   *  fine (React keys are stable, so the focused node survives a normal
   *  save); it is only the teardown paths that needed this. */
  const checkboxRefs = useRef(new Map<string, HTMLInputElement>());
  const restoreFocusTo = useRef<string | null>(null);
  const orphanAlertRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setTas(null);
    setLoadError(false);
    // #204 (ACC-028): the loading and failure states are announced from
    // here, through the one permanently-mounted region, rather than by
    // mounting a `role="status"` / `role="alert"` block that already
    // contains its text.
    announce("Loading teaching assistants…");
    // NOT setSaveError(null): a 404 on a save calls load() to drop the stale
    // row, and clearing the error here unmounted the only explanation the
    // instructor ever got. The refetched roster no longer contains that TA,
    // so the inline message had nowhere to render either -- the toggle
    // simply reverted with no stated reason (#172 audit, USE-010). The
    // orphan notice below is what keeps it on screen.
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
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
        announce(
          rows.length === 1
            ? "1 teaching assistant loaded."
            : `${rows.length} teaching assistants loaded.`,
        );
      })
      .catch((err: unknown) => {
        // An unmount/course-change abort is not a load failure -- reporting
        // it would flash an error banner on the way out.
        if ((err as Error)?.name === "AbortError") return;
        setLoadError(true);
        announce("Failed to load teaching assistants for this course.");
      })
      .finally(dispose);
  }, [courseId, announce]);

  // Runs after the roster re-renders. If the row survived, put focus back on
  // the exact checkbox; if it did not, put it on the notice explaining why,
  // so the user lands on the answer rather than on <body> (#196).
  useEffect(() => {
    const pending = restoreFocusTo.current;
    if (!pending || tas === null) return;
    restoreFocusTo.current = null;
    const control = checkboxRefs.current.get(pending);
    if (control) control.focus();
    else orphanAlertRef.current?.focus();
  }, [tas]);

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
      const column = CAPABILITY_COLUMNS.find((c) => c.field === field)!;
      const who = ta.displayName || ta.email || ta.userId;
      // #204 (ACC-024): the re-entry guard was a bare `return`. The control
      // is deliberately not `disabled` while saving (ACC-002), so the browser
      // toggles the DOM checkbox on the second press and React then reverts
      // it -- with nothing announced. A VoiceOver user pressing Space twice
      // during a slow save heard the toggle, heard nothing about the revert,
      // and walked away believing the opposite of what is stored.
      if (savingIds.has(key)) {
        announce(`Still saving ${column.label} for ${who} — please wait.`);
        return;
      }
      const next = !ta[field];

      setSavingIds((prev) => new Set(prev).add(key));
      setSaveError(null);
      announce(`Saving ${column.label} for ${who}…`);
      // Composed, not `abortRef.current?.signal` alone: the lifecycle signal
      // has no timeout, so a PATCH against a hung Worker stayed pending
      // forever with the row stuck on "Saving…" and no way back except a
      // reload (#172 audit, REL-011).
      const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
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
          // #204 (ACC-025): NOT announced on the 404 path. That path refetches,
          // the row disappears, and the same string lands in the orphan
          // notice, which is then focused (#196) -- so a polite write here
          // made one event produce two announcements, the assertive one able
          // to clip the polite copy. One message, one channel.
          if (res.status !== 404) announce(message);
          // A 404 means the row is stale — refetch so it stops being offered.
          if (res.status === 404) {
            // Remember where the user was standing; the refetch is about to
            // unmount it (#196).
            restoreFocusTo.current = key;
            load();
          }
          return;
        }
        const grant = parseGrant(await res.json());
        // The membership check is the point: a proxy or a mis-keyed handler
        // answering with a *different* TA's grant would otherwise be written
        // onto the row the instructor was actually editing.
        if (!grant || grant.membershipId !== ta.membershipId) {
          const message = "The server returned an unexpected response. Reload the console.";
          setSaveError({ membershipId: ta.membershipId, field, message });
          announce(message);
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
        announce(
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
        announce(message);
      } finally {
        dispose();
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [courseId, load, savingIds, announce],
  );

  /** #210: POSTs the entered NetIDs and hands the per-entry results back to
   *  the panel, which renders one line per NetID. Refetches on any success so
   *  a newly added TA appears in the grant table immediately -- otherwise the
   *  instructor is told someone was added and cannot then grant them
   *  anything without a reload. */
  const addTas = useCallback(
    async (netids: string[]): Promise<AddTaResult[]> => {
      const { signal, dispose } = abortAfter(30_000, abortRef.current?.signal ?? null);
      try {
        const res = await fetch(`/api/courses/${courseId}/tas`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ netids }),
          signal,
        });
        if (!res.ok) throw new Error(await errorMessageFor(res, "Could not add those TAs."));
        const body = (await res.json()) as { results?: unknown };
        const results = Array.isArray(body.results) ? (body.results as AddTaResult[]) : [];
        if (results.some((r) => r.status === "added" || r.status === "restored")) load();
        return results;
      } finally {
        dispose();
      }
    },
    [courseId, load],
  );

  /** #210: removal is a soft drop server-side -- the row survives, because
   *  submissions and audit events reference it -- but from the instructor's
   *  side it revokes access, so it is confirmed before it is sent. */
  const removeTa = useCallback(
    async (ta: TaCapabilities) => {
      const who = ta.displayName || ta.email || ta.userId;
      const confirmed = window.confirm(
        `Remove ${who} from this course?\n\nThey lose access to the submissions dashboard and student answers, and any permissions you granted them are revoked. You can add them again by NetID.`,
      );
      if (!confirmed) return;

      setSaveError(null);
      announce(`Removing ${who}…`);
      const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
      try {
        const res = await fetch(`/api/courses/${courseId}/tas/${ta.membershipId}`, {
          method: "DELETE",
          signal,
        });
        if (!res.ok) {
          const message = await errorMessageFor(
            res,
            "Could not remove that teaching assistant.",
          );
          setSaveError({ membershipId: ta.membershipId, field: "canViewSolutions", message });
          announce(message);
          // Same reasoning as the 404 path in `toggle`: the row is stale, so
          // refetch rather than leaving an action on screen that cannot work.
          if (res.status === 404) load();
          return;
        }
        announce(`${who} removed from this course.`);
        load();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message =
          (err as Error)?.name === "TimeoutError"
            ? "That removal timed out. Reload to check whether it was applied."
            : "Could not remove that teaching assistant. Please try again.";
        setSaveError({ membershipId: ta.membershipId, field: "canViewSolutions", message });
        announce(message);
      } finally {
        dispose();
      }
    },
    [courseId, load, announce],
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

      {/* #204 (ACC-028): the view's ONE announcement channel. Mounted
          unconditionally so announcements are reliable (ACC-004), and every
          status string below is written here rather than inserted into the
          DOM inside a fresh live region -- which is the same pattern ACC-004
          named, and which the loading and failure blocks were still using.

          The single exception is the orphan notice: it is focus-managed
          (#196), so a screen reader reads it on focus, and writing it here
          as well is the double-announcement ACC-025 filed. */}
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      {/* A save error whose row is no longer on screen -- because load() is
          refetching after a 404, or because the refetch confirmed the TA is
          gone. Rendered here, outside the roster conditional below, so the
          explanation outlives the row it was attached to (#172 audit,
          USE-010). */}
      {saveError && !tas?.some((t) => t.membershipId === saveError.membershipId) && (
        // tabIndex -1 so focus can be moved here programmatically when the
        // row the error belonged to is gone (#196) -- not reachable by Tab.
        <div className="admin-alert" role="alert" tabIndex={-1} ref={orphanAlertRef}>
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{saveError.message}</span>
        </div>
      )}

      {loadError ? (
        // #204 (ACC-028): no role here. The block is inserted into the DOM
        // already containing its text, which is the pattern ACC-004 named --
        // announcement is unreliable. `load`'s catch writes the same sentence
        // to the permanent region above, which is reliable.
        <div className="admin-alert">
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
        // Likewise: visible text only. `load` announces the loading state.
        <p>Loading teaching assistants…</p>
      ) : tas.length === 0 ? (
        // #192: this empty state used to be a dead end -- it stated that no
        // TAs were assigned and stopped, on the one page whose entire purpose
        // is "give my TA access", with no enrollment surface anywhere in the
        // console. The instructor's only remaining options were to email a
        // developer or hand over the answer key out of band, which is exactly
        // what the per-course grant model exists to prevent. #210 supplies
        // the missing action, so the empty state now opens with it.
        <>
          <AddTasPanel
            onAdd={addTas}
            defaultOpen
            maxPerRequest={MAX_TAS_PER_REQUEST}
            onAnnounce={announce}
          />
          <div className="admin-empty">
            <Users size={22} weight="regular" aria-hidden="true" />
            <p>
              No teaching assistants are assigned to this course yet. Add them by UW NetID
              above; once they sign in they appear here and you can grant access to model
              solutions or unreleased homeworks.
            </p>
          </div>
        </>
      ) : (
        <>
        <AddTasPanel onAdd={addTas} maxPerRequest={MAX_TAS_PER_REQUEST} onAnnounce={announce} />
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
              <th scope="col">
                <span className="admin-visually-hidden">Remove from course</span>
              </th>
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
                      {/* A pending TA has no display name yet -- it arrives
                          from WorkOS at first login -- so the NetID-derived
                          email is all there is to identify them by. Saying
                          "(no name on file)" for someone who simply has not
                          signed in yet reads as a data problem. */}
                      {ta.displayName || (ta.isPending ? ta.email.split("@")[0] : "(no name on file)")}
                      {ta.isPending && (
                        <span className="admin-pending-mark" title="Added by NetID; has not signed in yet">
                          Invited
                        </span>
                      )}
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
                          ref={(el) => {
                            const k = savingKey(ta.membershipId, c.field);
                            if (el) checkboxRefs.current.set(k, el);
                            else checkboxRefs.current.delete(k);
                          }}
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
                  <td className="admin-table__actions">
                    <button
                      type="button"
                      className="admin-link-button admin-link-button--danger"
                      /* The row header names the person, but a screen reader
                         running a controls list reads each name on its own,
                         where five identical "Remove" buttons are unusable.
                         #195 (ACC-021)'s rule holds: the accessible name
                         LEADS with the visible word, so Voice Control and
                         Dragon still match on what is on screen. */
                      aria-label={`Remove ${who} from this course`}
                      onClick={() => removeTa(ta)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </>
      )}
    </div>
  );
}
