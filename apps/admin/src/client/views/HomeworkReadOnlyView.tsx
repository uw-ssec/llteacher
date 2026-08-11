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

const HOMEWORK_STATUSES: readonly HomeworkStatus[] = [
  "draft",
  "scheduled",
  "active",
  "past_due",
  "hidden",
  "archived",
];

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
    status: HOMEWORK_STATUSES.includes(h.status as HomeworkStatus)
      ? (h.status as HomeworkStatus)
      : null,
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
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHomework(null);
    setLoadError(false);
    const { signal, dispose } = abortAfter(15_000);
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = parseDetail(data);
        if (!parsed) throw new Error("unexpected shape");
        setHomework(parsed);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(dispose);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [courseId, homeworkId]);

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

  if (loadError) {
    return (
      <div className="admin-view">
        {heading}
        <p role="alert">Failed to load this homework.</p>
      </div>
    );
  }
  if (!homework) {
    return (
      <div className="admin-view">
        {heading}
        <p role="status">Loading homework…</p>
      </div>
    );
  }

  const anySolutions = homework.sections.some((s) => s.solution !== null);

  return (
    <div className="admin-view">
      {heading}

      {!anySolutions && (
        <div className="admin-alert" role="status">
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
                <h3 className="admin-record-row__title-static">
                  {section.order}. {section.title}
                </h3>
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
