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
  status: HomeworkStatus;
  sections: SectionPayload[];
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
    status: (typeof h.status === "string" ? h.status : "active") as HomeworkStatus,
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
}: {
  courseId: string;
  homeworkId: string;
  onBack: () => void;
}) {
  const [homework, setHomework] = useState<HomeworkDetailPayload | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHomework(null);
    setLoadError(false);
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, {
      signal: AbortSignal.timeout(15_000),
    })
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
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, homeworkId]);

  if (loadError) {
    return (
      <div className="admin-view">
        <button type="button" className="admin-back" onClick={onBack}>
          <ArrowLeft size={14} weight="regular" aria-hidden="true" />
          All homeworks
        </button>
        <p role="alert">Failed to load this homework.</p>
      </div>
    );
  }
  if (!homework) return <p role="status">Loading homework…</p>;

  const anySolutions = homework.sections.some((s) => s.solution !== null);

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        All homeworks
      </button>

      <PageHeader
        eyebrow="HOMEWORK"
        title={homework.title}
        subtitle={`${homework.sections.length} sections · read-only`}
        actions={<StatusBadge kind={homework.status}>{homework.status}</StatusBadge>}
      />

      {!anySolutions && (
        <div className="admin-alert" role="status">
          <span className="admin-alert__icon" aria-hidden="true">
            <Lock size={16} weight="regular" />
          </span>
          <span>
            Model solutions are not shown. An instructor grants access to them per course under
            TA permissions.
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
