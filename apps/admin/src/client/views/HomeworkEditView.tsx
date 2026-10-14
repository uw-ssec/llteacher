import { useEffect, useRef, useState } from "react";
import {
  HomeworkForm,
  HomeworkSaveError,
  type HomeworkFormInitialData,
} from "../components/HomeworkForm";
import { AdminNotice } from "../components/AdminNotice";
import type { LlmConfigPayload } from "@llteacher/ui/api";

/** ISO datetime string -> the `YYYY-MM-DDTHH:mm` shape a <input
 *  type="datetime-local"> requires, in the *browser's local* timezone (a
 *  raw ISO string with seconds/ms/Z is rejected by the input and silently
 *  renders blank -- no error, just an empty field, so the conversion is not
 *  optional). */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

export function HomeworkEditView({
  courseId,
  homeworkId,
  llmConfigs,
  onSaved,
  onCancel,
}: {
  courseId: string;
  homeworkId: string;
  llmConfigs: LlmConfigPayload[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [initialData, setInitialData] =
    useState<HomeworkFormInitialData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const persistedHideStateRef = useRef<{
    hidden: boolean;
    expiresAt: string | null;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Captured once, from the same load that populates the form -- onSubmit
  // compares against these to decide whether the publish state actually
  // changed, instead of unconditionally PATCHing /publish on every save
  // (which would otherwise silently overwrite an already-scheduled release
  // timestamp on an unrelated edit).
  const [originalPublishState, setOriginalPublishState] = useState<{
    publish: boolean;
    releasedAt: string | undefined;
  } | null>(null);
  // #166: captured the same way originalPublishState is, from the same
  // initial load -- onSubmit compares against these to decide whether the
  // hide/expiry fields actually changed, instead of unconditionally
  // PATCHing /hide on every save (same rationale as originalPublishState
  // above, applied to the hide/expiry pair).
  const [originalHideState, setOriginalHideState] = useState<{
    hidden: boolean;
    expiresAt: string | null;
  } | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load homework");
        return r.json();
      })
      .then((hw) => {
        const hasFutureRelease =
          hw.publishedAt !== null &&
          hw.releasedAt !== null &&
          new Date(hw.releasedAt).getTime() > Date.now();
        setInitialData({
          title: hw.title,
          description: hw.description,
          dueDate: toDatetimeLocalValue(hw.dueDate),
          llmConfigId: hw.llmConfigId,
          status: hw.status,
          releasedAt: hw.releasedAt
            ? toDatetimeLocalValue(hw.releasedAt)
            : null,
          isHidden: hw.isHidden,
          expiresAt: hw.expiresAt ? toDatetimeLocalValue(hw.expiresAt) : null,
          publishedAt: hw.publishedAt,
          sections: hw.sections.map(
            (s: {
              id: string;
              title: string;
              order: number;
              content: string;
              type: "conversation" | "non_interactive";
              solution: { content: string } | null;
            }) => ({
              id: s.id,
              homeworkId,
              title: s.title,
              order: s.order,
              type: s.type,
              hasSolution: !!s.solution,
              submissionsCount: 0,
              content: s.content,
              solutionContent: s.solution?.content,
            }),
          ),
          widgets: hw.widgets.map(
            (w: {
              id: string;
              prePrompt: string;
              postPrompt: string;
              order: number;
            }) => ({
              id: w.id,
              prePrompt: w.prePrompt,
              postPrompt: w.postPrompt,
              order: w.order,
            }),
          ),
        });
        setOriginalPublishState({
          // #166: keyed off publishedAt, not status -- "hidden" can now mask
          // an otherwise-draft homework (Resolved Design Decision 17's
          // precedence), so `status !== "draft"` stopped being a reliable
          // "is this published" proxy once a draft could be hidden too.
          publish: hw.publishedAt !== null,
          // Compare the API's absolute instant with the form's normalized
          // submit payload. Visibility can mask a scheduled status, so the
          // future release timestamp is the authoritative signal here.
          releasedAt: hasFutureRelease
            ? new Date(hw.releasedAt).toISOString()
            : undefined,
        });
        const loadedHideState = {
          hidden: hw.isHidden,
          expiresAt: hw.expiresAt ? toDatetimeLocalValue(hw.expiresAt) : null,
        };
        setOriginalHideState(loadedHideState);
        persistedHideStateRef.current = loadedHideState;
      })
      .catch(() => setLoadError("Failed to load homework. Please try again."));
  }, [courseId, homeworkId]);

  if (loadError) {
    return (
      <div className="admin-view">
        <button type="button" className="admin-back" onClick={onCancel}>
          Cancel
        </button>
        <AdminNotice
          eyebrow="Could not load"
          title="This homework didn't load"
          body="The assignment couldn't be fetched for editing. Nothing has been saved or changed — reopening it is safe."
          detail={`GET /api/courses/${courseId}/homeworks/${homeworkId}`}
          secondaryAction={{ label: "Back", onClick: onCancel }}
        />
      </div>
    );
  }

  if (!initialData || !originalPublishState || !originalHideState) return null;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>
        Cancel
      </button>
      <HomeworkForm
        initialData={initialData}
        llmConfigs={llmConfigs}
        isLoading={isSubmitting}
        onSubmit={async (payload) => {
          if (submittingRef.current) return;
          submittingRef.current = true;
          setIsSubmitting(true);
          try {
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
                await responseError(patchRes, "Failed to save homework"),
                "none",
              );
            }

            // Apply visibility before publication so a requested hidden state
            // cannot fail after a draft has already become student-visible.
            const requestedHideState = {
              hidden: payload.hidden,
              expiresAt: payload.expiresAt || null,
            };
            const persistedHideState =
              persistedHideStateRef.current ?? originalHideState;
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
                  "partial",
                );
              }
              persistedHideStateRef.current = requestedHideState;
            }

            const publishChanged =
              payload.publish !== originalPublishState.publish ||
              payload.releasedAt !== originalPublishState.releasedAt;
            if (publishChanged) {
              const publishRes = await fetch(
                `/api/courses/${courseId}/homeworks/${homeworkId}/publish`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    publish: payload.publish,
                    releasedAt: payload.releasedAt,
                  }),
                },
              );
              if (publishRes.status === 409) {
                const body = await publishRes.json();
                if (
                  body.hasStudentActivity &&
                  window.confirm(
                    "This homework already has student activity. Unpublish anyway?",
                  )
                ) {
                  const retryRes = await fetch(
                    `/api/courses/${courseId}/homeworks/${homeworkId}/publish`,
                    {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        publish: payload.publish,
                        releasedAt: payload.releasedAt,
                        confirm: true,
                      }),
                    },
                  );
                  if (!retryRes.ok) {
                    throw new HomeworkSaveError(
                      await responseError(
                        retryRes,
                        "Failed to update publication",
                      ),
                      "partial",
                    );
                  }
                } else {
                  throw new HomeworkSaveError(
                    "Publication was not changed",
                    "partial",
                  );
                }
              } else if (!publishRes.ok) {
                throw new HomeworkSaveError(
                  await responseError(
                    publishRes,
                    "Failed to update publication",
                  ),
                  "partial",
                );
              }
            }

            onSaved();
          } finally {
            submittingRef.current = false;
            setIsSubmitting(false);
          }
        }}
      />
    </div>
  );
}
