import { useRef, useState } from "react";
import { HomeworkForm, HomeworkSaveError } from "../components/HomeworkForm";
import { PageHeader } from "../components/PageHeader";
import type { LlmConfigPayload } from "@llteacher/ui/api";

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim()
      ? body.error
      : fallback;
  } catch {
    return fallback;
  }
}

export function HomeworkCreateView({
  courseId,
  llmConfigs,
  onCreated,
  onCancel,
}: {
  courseId: string;
  llmConfigs: LlmConfigPayload[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const draftIdRef = useRef<string | null>(null);
  const persistedHideStateRef = useRef<{
    hidden: boolean;
    expiresAt: string | null;
  }>({ hidden: false, expiresAt: null });
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>
        Cancel
      </button>
      {/* #328: the view had no heading at all -- "Cancel" was standing in for
          a page title, and "New homework" appeared only in the breadcrumb. */}
      <PageHeader
        eyebrow="HOMEWORK"
        title="New homework"
        subtitle="Sections, the AI tutor configuration, and when students can see it."
      />
      <HomeworkForm
        llmConfigs={llmConfigs}
        isLoading={isSubmitting}
        onSubmit={async (payload) => {
          if (submittingRef.current) return;
          submittingRef.current = true;
          setIsSubmitting(true);
          try {
            let homeworkId = draftIdRef.current;
            if (!homeworkId) {
              const res = await fetch(`/api/courses/${courseId}/homeworks`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: payload.title,
                  description: payload.description,
                  dueDate: payload.dueDate,
                }),
              });
              if (!res.ok) {
                throw new HomeworkSaveError(
                  await responseError(res, "Failed to create homework"),
                  "none",
                );
              }
              const created = (await res.json()) as { id: string };
              homeworkId = created.id;
              draftIdRef.current = homeworkId;
            }

            const patchRes = await fetch(
              `/api/courses/${courseId}/homeworks/${homeworkId}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: payload.title,
                  description: payload.description,
                  dueDate: payload.dueDate,
                  llmConfigId: payload.llmConfigId,
                  sections: payload.sections,
                  widgets: payload.widgets,
                }),
              },
            );
            if (!patchRes.ok) {
              throw new HomeworkSaveError(
                await responseError(
                  patchRes,
                  "Failed to save homework details",
                ),
                "draft",
              );
            }
            // Reconcile against the last visibility state that actually
            // reached the server; a later publish failure can leave this step
            // committed across retries.
            const requestedHideState = {
              hidden: payload.hidden,
              expiresAt: payload.expiresAt || null,
            };
            const persistedHideState = persistedHideStateRef.current;
            const hideChanged =
              requestedHideState.hidden !== persistedHideState.hidden ||
              requestedHideState.expiresAt !== persistedHideState.expiresAt;
            if (hideChanged) {
              const hideRes = await fetch(
                `/api/courses/${courseId}/homeworks/${homeworkId}/hide`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    isHidden: requestedHideState.hidden,
                    expiresAt: requestedHideState.expiresAt,
                  }),
                },
              );
              if (!hideRes.ok) {
                throw new HomeworkSaveError(
                  await responseError(hideRes, "Failed to update visibility"),
                  "draft",
                );
              }
              persistedHideStateRef.current = requestedHideState;
            }
            if (payload.publish) {
              const publishRes = await fetch(
                `/api/courses/${courseId}/homeworks/${homeworkId}/publish`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    publish: true,
                    releasedAt: payload.releasedAt,
                  }),
                },
              );
              if (!publishRes.ok) {
                throw new HomeworkSaveError(
                  await responseError(
                    publishRes,
                    "Failed to update publication",
                  ),
                  "draft",
                );
              }
            }
            onCreated(homeworkId);
          } finally {
            submittingRef.current = false;
            setIsSubmitting(false);
          }
        }}
      />
    </div>
  );
}
