import { useEffect, useState } from "react";
import { HomeworkForm, type HomeworkFormInitialData, type LLMConfigOption } from "../components/HomeworkForm";

/** ISO datetime string -> the `YYYY-MM-DDTHH:mm` shape a <input
 *  type="datetime-local"> requires, in the *browser's local* timezone (a
 *  raw ISO string with seconds/ms/Z is rejected by the input and silently
 *  renders blank -- that's I2 from the final review). */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  llmConfigs: LLMConfigOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [initialData, setInitialData] = useState<HomeworkFormInitialData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Captured once, from the same load that populates the form -- onSubmit
  // compares against these to decide whether the publish state actually
  // changed, instead of unconditionally PATCHing /publish on every save
  // (which would otherwise silently overwrite an already-scheduled release
  // timestamp on an unrelated edit -- see final review finding I3).
  const [originalPublishState, setOriginalPublishState] = useState<{ publish: boolean; releasedAt: string | undefined } | null>(null);
  // #166: captured the same way originalPublishState is, from the same
  // initial load -- onSubmit compares against these to decide whether the
  // hide/expiry fields actually changed, instead of unconditionally
  // PATCHing /hide on every save (same rationale as final review finding I3
  // for /publish).
  const [originalHideState, setOriginalHideState] = useState<{ hidden: boolean; expiresAt: string | undefined } | null>(null);
  // Same double-submit gap as HomeworkCreateView -- the Save button was
  // never disabled during the PATCH -> publish -> hide chain, so a second
  // click while the first was still in flight fired an independent submit.
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load homework");
        return r.json();
      })
      .then((hw) => {
        setInitialData({
          title: hw.title,
          description: hw.description,
          dueDate: toDatetimeLocalValue(hw.dueDate),
          llmConfigId: hw.llmConfigId,
          status: hw.status,
          releasedAt: hw.releasedAt ? toDatetimeLocalValue(hw.releasedAt) : null,
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
          widgets: hw.widgets.map((w: { id: string; prePrompt: string; postPrompt: string; order: number }) => ({
            id: w.id,
            prePrompt: w.prePrompt,
            postPrompt: w.postPrompt,
            order: w.order,
          })),
        });
        setOriginalPublishState({
          // #166: keyed off publishedAt, not status -- "hidden" can now mask
          // an otherwise-draft homework (Resolved Design Decision 17's
          // precedence), so `status !== "draft"` stopped being a reliable
          // "is this published" proxy once a draft could be hidden too.
          publish: hw.publishedAt !== null,
          // NOTE (deviation from the fix brief's literal text, called out in
          // the fix report): the brief said to use `undefined` here "so both
          // sides of the !== comparison are in the same shape" against
          // payload.releasedAt. Empirically, react-hook-form's uncontrolled
          // datetime-local `register("releasedAt")` returns "" (not
          // `undefined`) on submit when the field was never touched -- the
          // exact same uncontrolled-<input>-always-a-string class of bug as
          // C1's llmConfigId. Using `undefined` here would make this always
          // read as "changed" for any homework with no releasedAt, which is
          // the majority case, defeating I3's fix and failing its own
          // "does not call /publish when untouched" test. "" matches what
          // the form actually produces, so the comparison now holds.
          releasedAt: hw.releasedAt ? toDatetimeLocalValue(hw.releasedAt) : "",
        });
        // #166: same "" vs undefined reasoning as originalPublishState above
        // -- the uncontrolled expiresAt datetime-local input sends "" for an
        // untouched field, never undefined.
        setOriginalHideState({
          hidden: hw.isHidden,
          expiresAt: hw.expiresAt ? toDatetimeLocalValue(hw.expiresAt) : "",
        });
      })
      .catch(() => setLoadError("Failed to load homework. Please try again."));
  }, [courseId, homeworkId]);

  if (loadError) {
    return (
      <div className="admin-view">
        <button type="button" className="admin-back" onClick={onCancel}>
          Cancel
        </button>
        <p role="alert">{loadError}</p>
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
          setIsSubmitting(true);
          try {
            const patchRes = await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, {
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
            });
            if (!patchRes.ok) throw new Error("Failed to save homework");

            const publishChanged =
              payload.publish !== originalPublishState.publish ||
              payload.releasedAt !== originalPublishState.releasedAt;
            if (publishChanged) {
              const publishRes = await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/publish`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ publish: payload.publish, releasedAt: payload.releasedAt }),
              });
              if (publishRes.status === 409) {
                const body = await publishRes.json();
                if (body.hasStudentActivity && window.confirm("This homework already has student activity. Unpublish anyway?")) {
                  const retryRes = await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/publish`, {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ publish: payload.publish, releasedAt: payload.releasedAt, confirm: true }),
                  });
                  if (!retryRes.ok) throw new Error("Failed to update publish state");
                } else {
                  throw new Error("Publish state not changed");
                }
              } else if (!publishRes.ok) {
                throw new Error("Failed to update publish state");
              }
            }

            // #166: distinct from publish/unpublish -- its own conditional
            // call, same "only PATCH when actually changed" guard as above.
            const hideChanged =
              payload.hidden !== originalHideState.hidden ||
              payload.expiresAt !== originalHideState.expiresAt;
            if (hideChanged) {
              const hideRes = await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/hide`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ isHidden: payload.hidden, expiresAt: payload.expiresAt }),
              });
              if (!hideRes.ok) throw new Error("Failed to update visibility state");
            }

            onSaved();
          } finally {
            setIsSubmitting(false);
          }
        }}
      />
    </div>
  );
}
