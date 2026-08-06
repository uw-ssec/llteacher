import { useEffect, useState } from "react";
import { HomeworkForm, type HomeworkFormInitialData } from "../components/HomeworkForm";
import type { LLMConfig } from "../lib/fixtures";

export function HomeworkEditView({
  courseId,
  homeworkId,
  llmConfigs,
  onSaved,
  onCancel,
}: {
  courseId: string;
  homeworkId: string;
  llmConfigs: LLMConfig[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [initialData, setInitialData] = useState<HomeworkFormInitialData | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`)
      .then((r) => r.json())
      .then((hw) =>
        setInitialData({
          title: hw.title,
          description: hw.description,
          dueDate: hw.dueDate,
          llmConfigId: hw.llmConfigId,
          status: hw.status,
          releasedAt: hw.releasedAt,
          sections: hw.sections.map(
            (s: {
              id: string;
              title: string;
              order: number;
              content: string;
              solution: { content: string } | null;
            }) => ({
              id: s.id,
              homeworkId,
              title: s.title,
              order: s.order,
              hasSolution: !!s.solution,
              submissionsCount: 0,
              content: s.content,
              solutionContent: s.solution?.content,
            }),
          ),
        }),
      );
  }, [courseId, homeworkId]);

  if (!initialData) return null;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>
        Cancel
      </button>
      <HomeworkForm
        initialData={initialData}
        llmConfigs={llmConfigs}
        onSubmit={async (payload) => {
          await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: payload.title,
              description: payload.description,
              dueDate: payload.dueDate,
              llmConfigId: payload.llmConfigId,
              sections: payload.sections,
            }),
          });
          await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/publish`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ publish: payload.publish, releasedAt: payload.releasedAt }),
          });
          onSaved();
        }}
      />
    </div>
  );
}
