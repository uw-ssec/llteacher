/* --------------------------------------------------------------------------
   HomeworkReadOnlyView — what a non-authoring grader sees when they open a
   homework (#172 audit, FUN-002).

   Without this, a granted capability had no surface: an instructor could
   grant `can_view_solutions`, the API would correctly return the solution,
   and the TA clicking that homework in the list hit "You do not have
   permission to edit homeworks in this course". The grant worked end to end
   at the API and produced no observable effect anywhere in the product.

   Read-only by construction: it renders what the detail payload contains and
   offers no writes. The server is still the authority -- `solution` simply
   arrives null when the caller wasn't granted it, so this view shows what
   the caller may see without re-deriving any policy client-side.
   -------------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import { ArrowLeft, Lock } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { AdminNotice } from "../components/AdminNotice";
import { StatusBadge } from "../components/StatusBadge";
import { abortAfter } from "../lib/abortAfter";
import type { HomeworkStatus } from "./HomeworksView";

interface SectionPayload {
  id: string;
  title: string;
  content: string;
  order: number;
  type: "conversation" | "non_interactive";
  solution: { id: string; content: string } | null;
}

interface HomeworkDetailPayload {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  /** null when the payload carried no recognizable status. Deliberately not
   *  defaulted to "active" (#172 audit, FLX-005): this view exists largely
   *  to show *unreleased* homeworks to a granted TA, so labelling an
   *  unparseable status "active" would assert the one thing the reader most
   *  needs to be true. No badge is better than a wrong badge. */
  status: HomeworkStatus | null;
  sections: SectionPayload[];
}

/** #202 (#172 re-audit, MNT-029): built from a `satisfies Record<...>` map
 *  rather than written as a bare `readonly HomeworkStatus[]`, matching
 *  STATUS_LABEL in HomeworksView. A plain array is assignable while missing
 *  members, so adding a status to the union left this list short and silently
 *  narrowed `parseDetail` -- the unlisted status failed the membership test,
 *  became null, and rendered no badge. On the one view whose purpose is
 *  showing unreleased homeworks, "no badge" is the worst possible way to
 *  fail. This way the omission is a compile error. */
const HOMEWORK_STATUS_MEMBERS = {
  draft: true,
  scheduled: true,
  active: true,
  past_due: true,
  hidden: true,
  archived: true,
} satisfies Record<HomeworkStatus, true>;

function isHomeworkStatus(value: unknown): value is HomeworkStatus {
  return typeof value === "string" && value in HOMEWORK_STATUS_MEMBERS;
}

/** #191: carries which of the three outcomes a rejected load represents
 *  through the promise chain. An Error subclass rather than a resolved
 *  discriminated union so the existing then/catch shape is preserved and a
 *  genuine network rejection still lands in the same `.catch` -- it just
 *  arrives without this marker and is read as "failed". */
class LoadOutcome extends Error {
  constructor(readonly state: "unavailable" | "failed") {
    super(state);
    this.name = "LoadOutcome";
  }
}

function parseDetail(raw: unknown): HomeworkDetailPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.id !== "string" || typeof h.title !== "string") return null;
  if (!Array.isArray(h.sections)) return null;
  return {
    id: h.id,
    title: h.title,
    description: typeof h.description === "string" ? h.description : "",
    dueDate: typeof h.dueDate === "string" ? h.dueDate : "",
    status: isHomeworkStatus(h.status) ? h.status : null,
    sections: h.sections
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({
        id: String(s.id ?? ""),
        title: typeof s.title === "string" ? s.title : "",
        content: typeof s.content === "string" ? s.content : "",
        order: typeof s.order === "number" ? s.order : 0,
        type: s.type === "non_interactive" ? "non_interactive" : "conversation",
        solution:
          typeof s.solution === "object" && s.solution !== null
            ? {
                id: String((s.solution as Record<string, unknown>).id ?? ""),
                content: String((s.solution as Record<string, unknown>).content ?? ""),
              }
            : null,
      })),
  };
}

export function HomeworkReadOnlyView({
  courseId,
  homeworkId,
  onBack,
  canViewSolutions,
}: {
  courseId: string;
  homeworkId: string;
  onBack: () => void;
  /** The caller's grant in this course, threaded from /api/profile.
   *
   *  #172 audit (FUN-106): without it this view inferred "you weren't
   *  granted solutions" from "the payload contains no solutions" -- but the
   *  server also omits them when the author simply hasn't written any. A TA
   *  who *did* hold can_view_solutions, opening a homework with no solutions
   *  authored yet, was told their permissions were the reason. The two cases
   *  need different sentences and only the caller can tell them apart. */
  canViewSolutions: boolean;
}) {
  const [homework, setHomework] = useState<HomeworkDetailPayload | null>(null);
  /** #191 (#172 re-audit, USE-027): three outcomes, not one boolean.
   *
   *  Every non-2xx and every network error used to collapse into "Failed to
   *  load this homework." with no retry -- and the *most likely* non-2xx here
   *  is a deliberate 404 for content the caller may not see. That is a
   *  permissions outcome, not a failure: an instructor hides a homework while
   *  a TA has the list open, the TA clicks it, and the console tells them it
   *  is broken. They report an outage for a system behaving exactly as
   *  designed.
   *
   *  "unavailable" is terminal (retrying cannot succeed, so no button is
   *  offered); "failed" and "timeout" are transient and get one. */
  type LoadState = "unavailable" | "failed" | "timeout";
  const [loadState, setLoadState] = useState<LoadState | null>(null);
  /** #202 (MNT-032): the lifecycle signal is passed as abortAfter's parent,
   *  which is the shape TaCapabilitiesView already used against the same
   *  helper. The `let cancelled` flag layered on top of an unparented signal
   *  was a second cancellation idiom for one helper, written in the same PR
   *  -- and the weaker of the two, since it let an in-flight response settle
   *  before checking a variable rather than aborting the request. */
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setHomework(null);
    setLoadState(null);
    // One controller per effect run, aborted by this run's own cleanup, so
    // "the view moved on" is expressed the same way the timeout is: as an
    // abort on the request, not as a flag consulted after it settles.
    const lifecycle = new AbortController();
    const { signal, dispose } = abortAfter(15_000, lifecycle.signal);
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, { signal })
      .then(async (r) => {
        // 403 and 404 are the same answer from the reader's side -- "not
        // yours to see" -- and the server deliberately returns 404 rather
        // than 403 for unreleased content so that probing reveals nothing.
        // Treating them identically here keeps that property intact.
        if (r.status === 403 || r.status === 404) throw new LoadOutcome("unavailable");
        if (!r.ok) throw new LoadOutcome("failed");
        const parsed = parseDetail(await r.json());
        // A 200 whose body does not parse is a server or deploy-skew
        // problem, not a permissions one -- retrying is reasonable.
        if (!parsed) throw new LoadOutcome("failed");
        setHomework(parsed);
      })
      .catch((err: unknown) => {
        // An unmount or course-change abort is not a load failure; reporting
        // it would flash an error on the way out. Matches TaCapabilitiesView.
        const name = (err as Error)?.name;
        if (name === "AbortError") return;
        if (name === "TimeoutError") return setLoadState("timeout");
        setLoadState(err instanceof LoadOutcome ? err.state : "failed");
      })
      .finally(dispose);
    return () => {
      lifecycle.abort();
      dispose();
    };
  }, [courseId, homeworkId, reloadNonce]);

  // The back button and a heading render in EVERY state, including loading
  // and error (#172 audit, ACC-009). The earlier early-returns dropped the
  // page's only <h1> and its only way out, so a screen-reader user landing
  // on a failed load had no heading to orient by and no link to leave with.
  const heading = (
    <>
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        All homeworks
      </button>

      <PageHeader
        eyebrow="HOMEWORK"
        title={homework?.title ?? "Homework"}
        subtitle={
          homework ? `${homework.sections.length} sections · read-only` : "read-only"
        }
        actions={
          homework?.status ? (
            <StatusBadge kind={homework.status}>{homework.status}</StatusBadge>
          ) : undefined
        }
      />
    </>
  );

  if (loadState !== null) {
    // #191: the permission outcome is a fact about access, not a fault, so
    // it takes AdminNotice's "denied" tone and offers no Try again — the
    // sibling view (TaCapabilitiesView) always offered one, and a retry
    // button on an outcome that cannot change is an invitation to click
    // until you conclude the console is broken.
    const notice =
      loadState === "unavailable"
        ? {
            eyebrow: "Not available",
            title: "This homework is not available to you",
            body: "It may have been withdrawn from release, or your access to unreleased homeworks may have changed. Ask the course instructor if you think you should be able to open it.",
            tone: "denied" as const,
            onRetry: undefined,
          }
        : loadState === "timeout"
          ? {
              eyebrow: "Timed out",
              title: "Loading this homework timed out",
              body: "The server did not answer within 15 seconds. This is usually temporary.",
              tone: "error" as const,
              onRetry: () => setReloadNonce((n) => n + 1),
            }
          : {
              eyebrow: "Could not load",
              title: "This homework didn't load",
              body: "The assignment and its sections couldn't be fetched. Nothing is missing on the server — this is a read-only view, so nothing was at risk.",
              tone: "error" as const,
              onRetry: () => setReloadNonce((n) => n + 1),
            };

    return (
      <div className="admin-view">
        {heading}
        <AdminNotice
          eyebrow={notice.eyebrow}
          title={notice.title}
          body={notice.body}
          tone={notice.tone}
          onRetry={notice.onRetry}
          detail={`GET /api/courses/${courseId}/homeworks/${homeworkId}`}
          secondaryAction={{ label: "Back", onClick: onBack }}
        />
      </div>
    );
  }
  if (!homework) {
    return (
      <div className="admin-view">
        {heading}
        <p>Loading homework…</p>
      </div>
    );
  }

  const anySolutions = homework.sections.some((s) => s.solution !== null);

  return (
    <div className="admin-view">
      {heading}

      {!anySolutions && (
        // #204 (ACC-028): no role="status". This is static prose stating a
        // standing fact about the page, not a status message announcing a
        // change -- and it is inserted already containing its text, so the
        // role bought nothing but a spurious announcement.
        <div className="admin-alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Lock size={16} weight="regular" />
          </span>
          <span>
            {canViewSolutions
              ? "No model solutions have been written for this homework yet."
              : "Model solutions are not shown. An instructor grants access to them per course under TA permissions."}
          </span>
        </div>
      )}

      <p className="admin-record-row__desc">{homework.description}</p>

      <section className="admin-record-list" aria-label="Sections">
        {[...homework.sections]
          .sort((a, b) => a.order - b.order)
          .map((section) => (
            <article key={section.id} className="admin-record-row">
              <div className="admin-record-row__body">
                {/* #204 (ACC-027): h2, not h3. These sit directly under
                    PageHeader's h1 with no h2 between, and this was the only
                    h3 in the admin client. The class carries the visual size
                    independently of the level, so nothing moves. */}
                <h2 className="admin-record-row__title-static">
                  {section.order}. {section.title}
                </h2>
                <p className="admin-record-row__desc">{section.content}</p>
                {section.solution && (
                  <details className="admin-solution">
                    <summary>Model solution</summary>
                    <p className="admin-record-row__desc">{section.solution.content}</p>
                  </details>
                )}
              </div>
            </article>
          ))}
      </section>
    </div>
  );
}
