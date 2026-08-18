/* --------------------------------------------------------------------------
   StudentsView — the course roster (#32), with CSV import (#86).

   Design note. The console's register is a card catalog, and a roster is the
   one list here that is genuinely long -- a course has hundreds of students
   where it has three configs and two TAs. So this is the one view that gets
   the full control set (search, status filter) rather than the sort-only
   treatment LLMConfigsView argues for: a search box over a list of three
   tells the reader the list is long enough to need searching, and over a
   list of three hundred it is the only way in.

   The status column is the load-bearing part. #32's requirement is that
   pending users are "visually distinct from active users", and the reason
   is operational rather than decorative: an instructor looking at a roster
   the day after an import needs to tell "they have not signed in yet" from
   "something went wrong", and those two look identical if the only signal is
   an empty Last active cell.

   Dropped members are shown, dimmed, rather than hidden. A removal that
   leaves no trace is indistinguishable from a person who was never added --
   and "why is this student gone" is a question this page exists to answer.
   -------------------------------------------------------------------------- */

import { useCallback, useMemo, useRef, useState } from "react";
import { Users, UploadSimple, Warning } from "@phosphor-icons/react";
import type { RosterMemberPayload, RosterMemberStatus } from "@llteacher/ui/api";
import { PageHeader } from "../components/PageHeader";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";
import { RosterImportPanel } from "../components/RosterImportPanel";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";

/** Copy per status, `satisfies Record<...>` so a status added to the wire
 *  contract fails to compile here rather than rendering a person with no
 *  stated state -- which on this page is the whole point. */
const STATUS = {
  active: { label: "Active", tone: "ok", help: "Has signed in." },
  pending: {
    label: "Invited",
    tone: "pending",
    help: "Added to the course but has not signed in yet.",
  },
  dropped: { label: "Removed", tone: "dropped", help: "No longer has access to this course." },
} satisfies Record<RosterMemberStatus, { label: string; tone: string; help: string }>;

type StatusFilter = "all" | RosterMemberStatus;

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function StudentsView({ courseId, courseTitle }: { courseId: string; courseTitle: string }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showImport, setShowImport] = useState(false);
  const [live, setLive] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /** #204's rule, applied here from the start: one permanently-mounted
   *  polite region, keyed on a monotonic nonce so an identical consecutive
   *  message still announces. */
  const announce = useCallback(
    (text: string) => setLive((prev) => ({ text, nonce: prev.nonce + 1 })),
    [],
  );

  const roster = useApiResource(
    (opts) => apiClient.roster.list(courseId, {}, opts),
    [courseId],
  );

  /* Filtering and search are CLIENT-side over the loaded roster, even
     though the API accepts a `search` parameter.

     The reason is the performance boundary the server documents: an exact
     email match uses the blind index, but a name match cannot -- the column
     is encrypted, so the server decrypts the whole course roster and filters
     in memory. Sending every keystroke there would repeat that decryption
     pass per keystroke to produce a subset of data this component already
     holds. The server parameter stays for a future roster large enough to
     paginate; today the honest implementation is to filter what we have. */
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (roster.data?.members ?? []).filter((m) => {
      if (statusFilter !== "all" && m.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        m.displayName.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)
      );
    });
  }, [roster.data, search, statusFilter]);

  const counts = useMemo(() => {
    const members = roster.data?.members ?? [];
    return {
      total: members.length,
      active: members.filter((m) => m.status === "active").length,
      pending: members.filter((m) => m.status === "pending").length,
      dropped: members.filter((m) => m.status === "dropped").length,
    };
  }, [roster.data]);

  const remove = useCallback(
    async (member: RosterMemberPayload) => {
      const who = member.displayName || member.email;
      if (
        !window.confirm(
          `Remove ${who} from this course?\n\nThey lose access to this course's homeworks and their work stops appearing in the submissions dashboard. Their submitted work is kept. You can add them again later.`,
        )
      ) {
        return;
      }
      setActionError(null);
      announce(`Removing ${who}…`);
      try {
        await apiClient.roster.remove(courseId, member.membershipId, { signal: null });
        announce(`${who} removed from this course.`);
        roster.reload();
      } catch (err) {
        const message =
          (err as Error)?.message ?? "Could not remove that person. Please try again.";
        setActionError(message);
        announce(message);
      }
    },
    [courseId, roster, announce],
  );

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="STUDENTS"
        title={`Roster · ${courseTitle}`}
        subtitle="Everyone enrolled in this course, including people who have been added but have not signed in yet."
        actions={
          <button
            type="button"
            className="admin-accession__open"
            onClick={() => setShowImport((v) => !v)}
          >
            <UploadSimple size={15} weight="regular" aria-hidden="true" />
            Import from CSV
          </button>
        }
      />

      {/* #204 (ACC-028): the view's ONE announcement channel, mounted for
          its whole lifetime and keyed on a counter so repeated identical
          messages still announce. */}
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      {showImport && (
        <RosterImportPanel
          courseId={courseId}
          onAnnounce={announce}
          onImported={() => {
            roster.reload();
            setShowImport(false);
          }}
          onClose={() => setShowImport(false)}
        />
      )}

      {actionError && (
        <div className="admin-alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{actionError}</span>
        </div>
      )}

      {roster.loading ? (
        <ViewLoading label="Loading the roster…" />
      ) : roster.error ? (
        <ViewError
          error={roster.error}
          onRetry={roster.reload}
          detail={`GET /api/courses/${courseId}/roster`}
        />
      ) : counts.total === 0 ? (
        <ViewEmpty
          icon={<Users size={22} weight="regular" />}
          title="Nobody is enrolled in this course yet."
          body="Import a roster from a CSV to add students. They appear here straight away, marked as invited until they sign in with their UW NetID."
          action={
            <button
              type="button"
              className="admin-accession__submit"
              onClick={() => setShowImport(true)}
            >
              Import from CSV
            </button>
          }
        />
      ) : (
        <>
          <div className="admin-roster-controls">
            <label className="admin-roster-controls__search">
              <span className="admin-visually-hidden">Search the roster by name or email</span>
              <input
                ref={searchRef}
                type="search"
                value={search}
                placeholder="Search by name or email"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>

            {/* Counts on the filters rather than beside them: an instructor
                choosing "Invited" wants to know how many there are BEFORE
                they click, which is the whole question ("has anyone not
                signed in?"). */}
            <div className="admin-roster-controls__filters" role="group" aria-label="Filter by status">
              {(
                [
                  ["all", `All ${counts.total}`],
                  ["active", `${STATUS.active.label} ${counts.active}`],
                  ["pending", `${STATUS.pending.label} ${counts.pending}`],
                  ["dropped", `${STATUS.dropped.label} ${counts.dropped}`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={
                    statusFilter === value
                      ? "admin-chip admin-chip--selected"
                      : "admin-chip"
                  }
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <ViewEmpty
              title="No one matches that."
              body={
                <>
                  Nothing in this roster matches{" "}
                  {search ? <strong>“{search}”</strong> : "that filter"}.{" "}
                  <button
                    type="button"
                    className="admin-link-button"
                    onClick={() => {
                      setSearch("");
                      setStatusFilter("all");
                      searchRef.current?.focus();
                    }}
                  >
                    Clear the filters
                  </button>
                </>
              }
            />
          ) : (
            <table className="admin-table admin-roster-table">
              <caption className="admin-visually-hidden">
                {`Roster for ${courseTitle}: ${visible.length} of ${counts.total} people`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last active</th>
                  <th scope="col">
                    <span className="admin-visually-hidden">Remove from course</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => {
                  const status = STATUS[m.status];
                  return (
                    <tr
                      key={m.membershipId}
                      className={m.status === "dropped" ? "admin-roster-row--dropped" : undefined}
                    >
                      <th scope="row">
                        <span className="admin-roster-row__identity">
                          <span className="admin-avatar" aria-hidden="true">
                            {m.initials}
                          </span>
                          <span>
                            <span className="admin-submission-row__name-label">
                              {/* A pending person has no display name until
                                  their first login supplies one; saying "(no
                                  name on file)" for someone who simply has
                                  not signed in reads as a data problem. */}
                              {m.displayName || (m.status === "pending" ? m.email.split("@")[0] : "—")}
                            </span>
                            <span className="admin-submission-row__name-id">{m.email}</span>
                          </span>
                        </span>
                      </th>
                      <td className="admin-roster-cell--role">{m.role}</td>
                      <td>
                        <span
                          className={`admin-roster-status admin-roster-status--${status.tone}`}
                          title={status.help}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="admin-submission-row__activity">
                        {m.status === "dropped"
                          ? `removed ${relativeTime(m.droppedAt)}`
                          : relativeTime(m.lastLoginAt)}
                      </td>
                      <td className="admin-table__actions">
                        {m.status === "dropped" ? (
                          <span className="admin-roster-cell--muted">—</span>
                        ) : (
                          <button
                            type="button"
                            className="admin-link-button admin-link-button--danger"
                            /* #195 (ACC-021): the accessible name LEADS with
                               the visible word, so voice control still
                               matches what is on screen, and a controls list
                               does not read five identical "Remove"s. */
                            aria-label={`Remove ${m.displayName || m.email} from this course`}
                            onClick={() => remove(m)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
