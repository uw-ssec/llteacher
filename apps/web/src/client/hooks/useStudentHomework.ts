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

export interface InstructorPreviewCourse {
  id: string;
  code: string;
  title: string;
  term: string;
}

function previewCourseName(course: InstructorPreviewCourse): string {
  return course.title.startsWith(course.code) ? course.title : `${course.code} · ${course.title}`;
}

/** Course-scoped homework navigation with independent live progress per
 * assignment. Setters capture the assignment ID, so a late request from a
 * previously opened homework cannot overwrite the newly selected one. */
export function useStudentHomework({ previewCourse }: { previewCourse?: InstructorPreviewCourse } = {}) {
  const [states, setStates] = useState<HomeworkState[]>([]);
  const [homeworkId, setHomeworkId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStates([]);
    setHomeworkId(undefined);
    setLoading(true);
    setLoadError(false);
    const endpoint = previewCourse
      ? `/api/courses/${encodeURIComponent(previewCourse.id)}/student-view/homeworks`
      : "/api/student/homeworks";
    fetch(endpoint)
      .then((response) => {
        if (!response.ok) throw new Error(`failed to load student homeworks: ${response.status}`);
        return response.json() as Promise<StudentHomeworkListResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        // Preserve the existing course choice until the course switcher in
        // #70 lands. Preview is stricter: even an invalid cross-course row
        // from the server is discarded against the already-validated course.
        const visibleHomeworks = previewCourse
          ? data.homeworks.filter((hw) => hw.courseId === previewCourse.id)
          : data.homeworks;
        const first = visibleHomeworks[0];
        const courseHomeworks = previewCourse
          ? visibleHomeworks
          : visibleHomeworks.filter((hw) => hw.courseId === first?.courseId);
        setStates(courseHomeworks.map((summary) => ({
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
  }, [previewCourse?.id]);

  const scopedStates = previewCourse
    ? states.filter((state) => state.summary.courseId === previewCourse.id)
    : states;
  const selected = scopedStates.find((state) => state.summary.id === homeworkId);
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
    homeworks: scopedStates.map((state) => state.summary),
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
    courseId: previewCourse?.id ?? selected?.summary.courseId,
    courseName: previewCourse ? previewCourseName(previewCourse) : selected?.summary.courseName ?? "",
    loading,
    loadError,
  };
}
