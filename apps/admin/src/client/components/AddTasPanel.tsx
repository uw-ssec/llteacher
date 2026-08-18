/* --------------------------------------------------------------------------
   AddTasPanel — putting teaching assistants on a course by UW NetID (#210).

   Design note. The console's register is a card catalog: warm paper ground,
   mono record ids (HW·003, CFG·001), ruled rows, uppercase mono eyebrows.
   This panel is an *accession slip* in that language -- you write down who is
   joining the record, and each name comes back stamped with what happened to
   it.

   That is not decoration; it is the requirement. #210 is explicit that a
   single collective "failed" is unusable when three of eight NetIDs were
   typos, so the outcome ledger below gives every entered NetID its own line
   and its own fate, in the same mono the rest of the console reserves for
   identifiers. The instructor reads it the way they would read a returns
   slip: down the left edge, one line per entry.

   Multi-entry by paste. Instructors adding TAs at the start of a term have
   the list in an email, separated by commas, newlines, or spaces -- so all
   three split, rather than making them reformat someone else's message.
   -------------------------------------------------------------------------- */

import { useId, useState } from "react";
import { UserPlus, Warning } from "@phosphor-icons/react";

/** Mirrors apps/web's AddTaResult. apps/admin never imports from apps/web --
 *  same convention as SubmissionsView and TaCapabilitiesView. */
export type AddTaStatus =
  | "added"
  | "restored"
  | "already_ta"
  | "invalid_netid"
  | "role_conflict";

export interface AddTaResult {
  netid: string;
  status: AddTaStatus;
  membershipId?: string;
  existingRole?: string;
}

/** Copy per outcome, keyed by status and `satisfies Record<AddTaStatus, ...>`
 *  so a status added on the server fails to compile here rather than
 *  rendering an entered NetID with no stated fate -- which is the one thing
 *  this panel exists to prevent.
 *
 *  `tone` drives the marker only. Three of the five are not failures, and
 *  dressing `already_ta` in the same red as `invalid_netid` would tell an
 *  instructor something is wrong when nothing is. */
const OUTCOME = {
  added: {
    tone: "ok",
    label: "Added",
    detail: "Invited. They appear below once they sign in with their NetID.",
  },
  restored: {
    tone: "ok",
    label: "Restored",
    detail: "Previously removed from this course. Re-added with no permissions.",
  },
  already_ta: {
    tone: "neutral",
    label: "Already a TA",
    detail: "No change — they were already on this course.",
  },
  invalid_netid: {
    tone: "warn",
    label: "Not a NetID",
    detail:
      "A NetID is 1–8 characters, starts with a letter, and contains only letters and numbers. Nothing was created.",
  },
  role_conflict: {
    tone: "warn",
    label: "Already enrolled",
    detail: "Already on this course under another role. Not changed.",
  },
} satisfies Record<AddTaStatus, { tone: "ok" | "neutral" | "warn"; label: string; detail: string }>;

/** Commas, newlines, semicolons, tabs and spaces all separate. An instructor
 *  is pasting from someone else's email, and reformatting it by hand is the
 *  kind of small tax that makes people give up and message a developer. */
export function splitNetids(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function AddTasPanel({
  onAdd,
  /** Open by default when the course has no TAs: on that page the panel IS
   *  the content, and #192's dead end was exactly a page that stated a fact
   *  and offered no next action. */
  defaultOpen = false,
  maxPerRequest,
  onAnnounce,
}: {
  onAdd: (netids: string[]) => Promise<AddTaResult[]>;
  defaultOpen?: boolean;
  maxPerRequest: number;
  onAnnounce: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<AddTaResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();

  const parsed = splitNetids(value);
  const overCap = parsed.length > maxPerRequest;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || parsed.length === 0 || overCap) return;
    setBusy(true);
    setError(null);
    onAnnounce(`Adding ${parsed.length === 1 ? "1 NetID" : `${parsed.length} NetIDs`}…`);
    try {
      const outcomes = await onAdd(parsed);
      setResults(outcomes);
      // Only the entries that landed are cleared from the box. A typo stays
      // where the instructor typed it, so correcting it is an edit rather
      // than a retype -- and the ledger beside it says which one to fix.
      const settled = new Set(
        outcomes.filter((r) => r.status !== "invalid_netid").map((r) => r.netid.toLowerCase()),
      );
      setValue(parsed.filter((n) => !settled.has(n.toLowerCase())).join("\n"));
      const changed = outcomes.filter(
        (r) => r.status === "added" || r.status === "restored",
      ).length;
      const failed = outcomes.length - changed;
      onAnnounce(
        `${changed} added, ${failed} not added. Results listed for each NetID.`,
      );
    } catch (err) {
      const message =
        (err as Error)?.name === "TimeoutError"
          ? "Adding those TAs timed out. Reload to check whether any were added."
          : "Could not add those TAs. Please try again.";
      setError(message);
      onAnnounce(message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="admin-accession admin-accession--closed">
        <button
          type="button"
          className="admin-accession__open"
          onClick={() => setOpen(true)}
        >
          <UserPlus size={15} weight="regular" aria-hidden="true" />
          Add teaching assistants
        </button>
      </div>
    );
  }

  return (
    <section className="admin-accession" aria-labelledby={`${fieldId}-heading`}>
      <h2 className="admin-accession__eyebrow" id={`${fieldId}-heading`}>
        Add teaching assistants
      </h2>

      <form onSubmit={submit}>
        <label className="admin-accession__label" htmlFor={fieldId}>
          UW NetIDs
        </label>
        <p className="admin-accession__hint" id={hintId}>
          One per line, or paste a list. A NetID is the part before <code>@uw.edu</code> —
          <code> alovelace</code>, not <code>alovelace@uw.edu</code>. Adding someone grants no
          access to solutions or unreleased homeworks; you grant those below, per person.
        </p>
        <textarea
          id={fieldId}
          className="admin-accession__field"
          aria-describedby={hintId}
          rows={4}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={"alovelace\nghopper"}
        />

        <div className="admin-accession__actions">
          <button
            type="submit"
            className="admin-accession__submit"
            disabled={busy || parsed.length === 0 || overCap}
          >
            {busy
              ? "Adding…"
              : parsed.length === 1
                ? "Add 1 TA"
                : `Add ${parsed.length || ""} TAs`.replace("  ", " ")}
          </button>
          <button
            type="button"
            className="admin-link-button"
            onClick={() => {
              setOpen(false);
              setResults(null);
              setError(null);
            }}
          >
            Close
          </button>
          {/* Stated before it is enforced, rather than discovered as a 400. */}
          {overCap && (
            <span className="admin-accession__cap">
              {parsed.length} NetIDs — add at most {maxPerRequest} at a time.
            </span>
          )}
        </div>
      </form>

      {error && (
        <div className="admin-alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{error}</span>
        </div>
      )}

      {results && results.length > 0 && (
        <ol className="admin-accession__ledger">
          {results.map((r) => {
            const copy = OUTCOME[r.status];
            return (
              <li
                key={r.netid}
                className={`admin-accession__entry admin-accession__entry--${copy.tone}`}
              >
                <span className="admin-accession__netid">{r.netid}</span>
                <span className="admin-accession__outcome">{copy.label}</span>
                <span className="admin-accession__detail">
                  {r.status === "role_conflict" && r.existingRole
                    ? `Already on this course as ${r.existingRole}. Not changed.`
                    : copy.detail}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
