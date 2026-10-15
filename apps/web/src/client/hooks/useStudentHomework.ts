import { useEffect, useState, type SetStateAction } from "react";
import type { SidebarSection } from "@llteacher/ui";
import type { StudentHomeworkListResponse, StudentHomeworkSummary, StudentProgressWidget } from "../../shared/types";

export interface SectionMeta {
  id: string;
  conversationId: string | null;
}

interface HomeworkState {
  summary: StudentHomeworkSummary;
  sections: SidebarSection[];
  sectionMetaByOrder: Map<number, SectionMeta>;
  widgets: StudentProgressWidget[];
}

const emptySections: SidebarSection[] = [];
const emptyMeta = new Map<number, SectionMeta>();
const emptyWidgets: StudentProgressWidget[] = [];

/** Course-scoped homework navigation with independent live progress per
 * assignment. Setters capture the assignment ID, so a late request from a
 * previously opened homework cannot overwrite the newly selected one. */
export function useStudentHomework() {
  const [states, setStates] = useState<HomeworkState[]>([]);
  const [homeworkId, setHomeworkId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/student/homeworks")
      .then((response) => {
        if (!response.ok) throw new Error(`failed to load student homeworks: ${response.status}`);
        return response.json() as Promise<StudentHomeworkListResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        // Preserve the existing course choice until the course switcher in
        // #70 lands. Never mix assignments from different courses.
        const first = data.homeworks[0];
        setStates(data.homeworks.filter((hw) => hw.courseId === first?.courseId).map((summary) => ({
          summary,
          sections: summary.sections.map((section) => ({
            number: section.order,
            title: section.title,
            status: section.status === "submitted" ? "submitted" as const
              : section.status === "in_progress" || section.status === "in_progress_overdue" ? "current" as const
                : "pending" as const,
            autoSubmitted: section.submissionSource === "auto",
          })),
          sectionMetaByOrder: new Map(summary.sections.map((section) => [section.order, {
            id: section.id, conversationId: section.conversationId,
          }])),
          widgets: summary.widgets ?? [],
        })));
        setHomeworkId(first?.id);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = states.find((state) => state.summary.id === homeworkId);
  const update = <K extends "sections" | "sectionMetaByOrder" | "widgets">(
    key: K, action: SetStateAction<HomeworkState[K]>,
  ) => {
    setStates((previous) => previous.map((state) => state.summary.id !== homeworkId ? state : {
      ...state,
      [key]: typeof action === "function"
        ? (action as (value: HomeworkState[K]) => HomeworkState[K])(state[key]) : action,
    }));
  };

  return {
    homeworks: states.map((state) => state.summary),
    homeworkId,
    selectHomework: (id: string) => {
      if (states.some((state) => state.summary.id === id)) setHomeworkId(id);
    },
    sections: selected?.sections ?? emptySections,
    setSections: (action: SetStateAction<SidebarSection[]>) => update("sections", action),
    sectionMetaByOrder: selected?.sectionMetaByOrder ?? emptyMeta,
    setSectionMetaByOrder: (action: SetStateAction<Map<number, SectionMeta>>) => update("sectionMetaByOrder", action),
    widgets: selected?.widgets ?? emptyWidgets,
    setWidgets: (action: SetStateAction<StudentProgressWidget[]>) => update("widgets", action),
    hwTitle: selected?.summary.title ?? "",
    courseId: selected?.summary.courseId,
    courseName: selected?.summary.courseName ?? "",
    loading,
    loadError,
  };
}
