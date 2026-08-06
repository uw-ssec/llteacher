import { HomeworkForm } from "../components/HomeworkForm";
import type { LLMConfig } from "../lib/fixtures";

export function HomeworkCreateView({
  courseId,
  llmConfigs,
  onCreated,
  onCancel,
}: {
  courseId: string;
  llmConfigs: LLMConfig[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>
        Cancel
      </button>
      <HomeworkForm
        llmConfigs={llmConfigs}
        onSubmit={async (payload) => {
          const res = await fetch(`/api/courses/${courseId}/homeworks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: payload.title,
              description: payload.description,
              dueDate: payload.dueDate,
            }),
          });
          if (!res.ok) throw new Error("Failed to create homework");
          const created = (await res.json()) as { id: string };
          // Section diff + publish state apply via the same PATCH path an
          // edit would use -- POST only creates the bare homework record
          // (matches the existing createHomeworkHandler's minimal contract
          // from Phase 1 Task 3, which predates sections/publish entirely).
          await fetch(`/api/courses/${courseId}/homeworks/${created.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ llmConfigId: payload.llmConfigId, sections: payload.sections }),
          });
          if (payload.publish) {
            await fetch(`/api/courses/${courseId}/homeworks/${created.id}/publish`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ publish: true, releasedAt: payload.releasedAt }),
            });
          }
          onCreated(created.id);
        }}
      />
    </div>
  );
}
