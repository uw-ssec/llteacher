import { useEffect, useState, type FormEvent } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Input } from "@llteacher/ui";
import type {
  AttachmentListPayload,
  CollectionListPayload,
  LlmConfigPayload,
  ResolutionPayload,
} from "@llteacher/ui/api";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";

/** #33: the section shape this form edits, declared where it is used rather
 *  than imported from the retired fixture module. It is the FORM's working
 *  type, not a wire payload -- `solutionContent` is optional here because
 *  the form may be mid-edit with none written, which is a different thing
 *  from what the API returns. */
export type SectionDetail = {
  id: string;
  homeworkId: string;
  title: string;
  order: number;
  hasSolution: boolean;
  submissionsCount: number;
  type: "conversation" | "non_interactive";
  content: string;
  solutionContent?: string;
};
import { computeSectionDiff, type FormSection } from "../lib/computeSectionDiff";
import { AdminNotice } from "./AdminNotice";

/** #165: an authored pre/post prompt pair, before the order-renumbering
 *  submit-time transform (mirrors FormSection's role for sections). */
export interface FormWidget {
  id?: string;
  prePrompt: string;
  postPrompt: string;
}

export interface WidgetDetail {
  id: string;
  prePrompt: string;
  postPrompt: string;
  order: number;
}

export interface HomeworkFormValues {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | undefined;
  sections: FormSection[];
  widgets: FormWidget[];
  publish: boolean;
  releasedAt: string | undefined;
  hidden: boolean;
  expiresAt: string | undefined;
}

export interface HomeworkFormInitialData {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  sections: SectionDetail[];
  widgets: WidgetDetail[];
  status: "draft" | "scheduled" | "active" | "past_due" | "hidden" | "archived";
  releasedAt: string | null;
  isHidden: boolean;
  expiresAt: string | null;
  /** #166: the Publish checkbox's default must key off this, not `status`
   *  -- "hidden" (Resolved Design Decision 17's precedence) can now mask an
   *  otherwise-draft homework's status, so `status !== "draft"` is no
   *  longer a reliable "is this published" proxy on its own. */
  publishedAt: string | null;
}

export interface HomeworkFormProps {
  initialData?: HomeworkFormInitialData;
  onSubmit: (payload: {
    title: string; description: string; dueDate: string; llmConfigId?: string;
    sections: ReturnType<typeof computeSectionDiff>;
    widgets: { id?: string; prePrompt: string; postPrompt: string; order: number }[];
    publish: boolean; releasedAt?: string;
    hidden: boolean; expiresAt?: string;
  }) => Promise<void>;
  llmConfigs: LlmConfigPayload[];
  isLoading?: boolean;
  /** #42: needed to load/mutate this course's knowledge collections. Always
   *  present — even in create mode, where nothing is fetched yet — because
   *  every call site already has it in scope. */
  courseId: string;
  /** #42: undefined in create mode. A collection cannot be attached to a
   *  homework that does not exist yet, so the knowledge fieldset only does
   *  real work once this is set. */
  homeworkId?: string;
}

const MAX_SECTIONS = 20;

/* `submitError` carries two unrelated kinds of message: this one (the network
   save actually failed) and form-shape complaints like "No more than 20
   sections". Only the former earns the reassurance copy about unsaved edits,
   so the render branch compares against this constant rather than dressing
   every submit error as a server failure. */
const SAVE_FAILED = "Failed to save homework. Please try again.";

export function HomeworkForm({ initialData, onSubmit, llmConfigs, isLoading, courseId, homeworkId }: HomeworkFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register, control, handleSubmit, watch, formState: { errors, isDirty },
  } = useForm<HomeworkFormValues>({
    defaultValues: initialData
      ? {
          title: initialData.title, description: initialData.description, dueDate: initialData.dueDate,
          llmConfigId: initialData.llmConfigId ?? undefined,
          sections: initialData.sections.map((s) => ({ id: s.id, title: s.title, content: s.content, solutionContent: s.solutionContent, type: s.type })),
          widgets: initialData.widgets.map((w) => ({ id: w.id, prePrompt: w.prePrompt, postPrompt: w.postPrompt })),
          publish: initialData.publishedAt !== null,
          releasedAt: initialData.releasedAt ?? undefined,
          hidden: initialData.isHidden,
          expiresAt: initialData.expiresAt ?? undefined,
        }
      : {
          title: "", description: "", dueDate: "", llmConfigId: undefined, sections: [], widgets: [], publish: false, releasedAt: undefined,
          hidden: false, expiresAt: undefined,
        },
  });
  /* #317 review, "strongly recommend before merge" -- carried across the
     #317/#363 merge, where this branch's rewrite of the picker dropped it:
     the <select> below is uncontrolled (register()), so its DOM value on
     mount is whatever <option> matches defaultValues.llmConfigId. If the
     assigned config is inactive (llmConfigs is pre-filtered to isActive) or
     the fetch failed, no matching <option> exists and the browser silently
     falls back to the FIRST option, "(course/org default)". Saving an
     unrelated field edit then PATCHes llmConfigId: "" -> null, dropping the
     override with no warning. Always including the currently-assigned id as
     its own option -- even when it's missing from the active list -- means
     the DOM's initial value always has somewhere real to land.

     Typed as the {id, name} subset the <option> actually reads, rather than
     LlmConfigPayload[]: the synthesised entry is a placeholder for a config
     this form could not load, so it has no real payload to stand in for. */
  const assignedConfigId = initialData?.llmConfigId ?? undefined;
  const selectableConfigs: { id: string; name: string }[] =
    assignedConfigId && !llmConfigs.some((cfg) => cfg.id === assignedConfigId)
      ? [...llmConfigs, { id: assignedConfigId, name: "Currently assigned (inactive or unavailable)" }]
      : llmConfigs;
  const { fields, append, remove } = useFieldArray({ control, name: "sections" });
  const { fields: widgetFields, append: appendWidget, remove: removeWidget } = useFieldArray({ control, name: "widgets" });

  useUnsavedChangesGuard(isDirty);

  /* #42: knowledge attachment lives here, not only on the collections
     screen, because this is where an instructor setting up an assignment
     will look for it.

     The resolution note below is not decoration. Attachment resolves
     most-specific-wins, so a section attachment silently replaces whatever
     is set here -- which is the one genuinely surprising consequence of
     override semantics, and the reason /knowledge/resolve returns the
     deciding `level` alongside the collections.

     Collections/attachments are only fetched once `homeworkId` exists: in
     create mode there is nothing to attach to, so a real GET here would be
     a wasted round-trip for data the fieldset never renders (see the
     `!homeworkId` branch of the JSX below). */
  const collections = useApiResource<CollectionListPayload>(
    (opts) =>
      homeworkId
        ? apiClient.knowledge.listCollections(courseId, opts)
        : Promise.resolve({ collections: [] }),
    [courseId, homeworkId],
  );
  const attachments = useApiResource<AttachmentListPayload>(
    (opts) =>
      homeworkId
        ? apiClient.knowledge.listAttachments(courseId, opts)
        : Promise.resolve({ attachments: [] }),
    [courseId, homeworkId],
  );
  const resolution = useApiResource<ResolutionPayload>(
    (opts) =>
      homeworkId
        ? apiClient.knowledge.resolve(courseId, { homeworkId }, opts)
        : Promise.resolve({ level: "none", collectionIds: [], documents: [] }),
    [courseId, homeworkId],
  );

  const attachedHere = new Map(
    (attachments.data?.attachments ?? [])
      .filter((a) => a.scope.kind === "homework" && a.scope.homeworkId === homeworkId)
      .map((a) => [a.collectionId, a.id]),
  );

  // C-1: `/knowledge/resolve` is called with only `homeworkId` (never a
  // `sectionId` -- there is no single section to ask about from this form),
  // so its section-level matcher can never fire and `resolution.data.level`
  // can never come back "section". The override warning has to be answered
  // from data this form already has instead: the homework's own section ids
  // (`initialData.sections`) and the course's attachment list it already
  // loads. A section of THIS homework overrides it exactly when some
  // attachment is scoped to one of those section ids.
  const homeworkSectionIds = new Set((initialData?.sections ?? []).map((s) => s.id));
  const sectionOverride =
    !!homeworkId &&
    (attachments.data?.attachments ?? []).some(
      (a) => a.scope.kind === "section" && homeworkSectionIds.has(a.scope.sectionId),
    );

  const [attachError, setAttachError] = useState<string | null>(null);
  // Guards against a double-click firing two overlapping attach/detach calls
  // for the same collection: `attachedHere` only updates once `attachments`
  // reloads, so two clicks inside that window would both read "not attached"
  // and both POST an attach, without this.
  const [pendingCollectionIds, setPendingCollectionIds] = useState<Set<string>>(new Set());

  async function toggleCollection(collectionId: string) {
    if (!homeworkId || pendingCollectionIds.has(collectionId)) return;
    setPendingCollectionIds((prev) => new Set(prev).add(collectionId));
    setAttachError(null);
    const existing = attachedHere.get(collectionId);
    try {
      if (existing) {
        await apiClient.knowledge.detach(courseId, existing, { signal: null });
      } else {
        await apiClient.knowledge.attach(
          courseId,
          collectionId,
          { kind: "homework", homeworkId },
          { signal: null },
        );
      }
      attachments.reload();
      resolution.reload();
    } catch (err) {
      // Standing rule for this feature: an attach/detach failure is reported,
      // not swallowed -- a silently-failed checkbox would leave the
      // instructor believing knowledge is attached when it is not (or vice
      // versa).
      setAttachError(
        (err as Error)?.message ?? "Could not update that attachment. Please try again.",
      );
    } finally {
      setPendingCollectionIds((prev) => {
        const next = new Set(prev);
        next.delete(collectionId);
        return next;
      });
    }
  }

  // The MAX_SECTIONS check must run *before* react-hook-form's own field
  // validation: each section's title/content are `required`, so 21 freshly
  // `append()`-ed (empty) sections would otherwise fail per-field validation
  // first and never reach a values-based length check inside handleSubmit's
  // callback. Checking `fields.length` directly (from useFieldArray, always
  // in sync with the array) sidesteps that.
  const onValid = handleSubmit(async (values) => {
    if (values.sections.length === 0) { setSubmitError("At least 1 section is required"); return; }
    setSubmitError(null);
    // Uncontrolled `register`-ed textareas fall back to the DOM's actual
    // value ("") when a section's solutionContent was left untouched, even
    // though it was appended as `undefined` -- normalize back to undefined
    // so an empty optional field doesn't get treated as "has a solution".
    const sections = values.sections.map((s) => ({ ...s, solutionContent: s.solutionContent || undefined }));
    // react-hook-form's handleSubmit rethrows whatever its callback throws
    // (verified against the installed react-hook-form: it catches only to
    // update internal form state, then rethrows) -- and `submit` below calls
    // `void onValid(e)`, discarding that promise. Without this try/catch, an
    // onSubmit rejection (a real API failure once Task 15 wires this to a
    // network call) becomes an unhandled promise rejection with no
    // user-facing feedback at all. Caught in task review before this landed.
    // Order is always renumbered 1..N from the form's current array order --
    // same convention computeSectionDiff already established for sections.
    const widgets = values.widgets.map((w, i) => ({
      ...(w.id !== undefined && { id: w.id }),
      prePrompt: w.prePrompt,
      postPrompt: w.postPrompt,
      order: i + 1,
    }));
    try {
      await onSubmit({
        title: values.title, description: values.description, dueDate: values.dueDate,
        llmConfigId: values.llmConfigId, sections: computeSectionDiff(sections),
        widgets,
        publish: values.publish, releasedAt: values.releasedAt,
        hidden: values.hidden, expiresAt: values.expiresAt,
      });
    } catch {
      setSubmitError(SAVE_FAILED);
    }
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    if (fields.length > MAX_SECTIONS) {
      e.preventDefault();
      setSubmitError(`No more than ${MAX_SECTIONS} sections`);
      return;
    }
    void onValid(e);
  };

  return (
    <form className="admin-form" onSubmit={submit} noValidate>
      <div className="admin-form-field">
        <Input
          label="Title"
          {...register("title", { required: "Title required" })}
          error={errors.title?.message}
        />
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-description">Description</label>
        <textarea id="hw-description" {...register("description")} />
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-due-date">Due date</label>
        <input id="hw-due-date" type="datetime-local" {...register("dueDate", { required: "Due date required" })} />
        <p className="admin-form-hint">
          The deadline. Once it passes the homework reads as past due and <strong>stays visible</strong> to students.
        </p>
        {errors.dueDate && <p role="alert" className="admin-field-error">{errors.dueDate.message}</p>}
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-llm-config">LLM config</label>
        <select id="hw-llm-config" {...register("llmConfigId")}>
          <option value="">(course/org default)</option>
          {selectableConfigs.map((cfg) => <option key={cfg.id} value={cfg.id}>{cfg.name}</option>)}
        </select>
      </div>

      <fieldset className="admin-form-group">
        <legend>Knowledge</legend>
        <p className="admin-form-hint">
          Collections the tutor grounds on for this assignment.
        </p>

        {/* Create mode: nothing exists yet for an attachment to point at, so
            say that rather than rendering checkboxes that cannot be saved. */}
        {!homeworkId && (
          <p className="admin-form-hint">
            Save the assignment first — knowledge can be attached once it exists.
          </p>
        )}

        {homeworkId && collections.error && (
          <AdminNotice
            eyebrow="Could not load"
            title="Collections didn't load"
            body="Knowledge attachments could not be checked — this does not mean nothing is attached."
            onRetry={collections.canRetry ? collections.reload : undefined}
          />
        )}

        {homeworkId && !collections.error && (collections.data?.collections ?? []).map((collection) => (
          <label key={collection.id} className="admin-form-check">
            <input
              type="checkbox"
              checked={attachedHere.has(collection.id)}
              disabled={pendingCollectionIds.has(collection.id)}
              onChange={() => void toggleCollection(collection.id)}
            />
            <span className="admin-form-check__label">{collection.name}</span>
          </label>
        ))}

        {homeworkId && !collections.error && (collections.data?.collections ?? []).length === 0 && (
          <p className="admin-form-hint">No collections exist yet for this course.</p>
        )}

        {attachError && <p role="alert" className="admin-field-error">{attachError}</p>}

        {/* The override note is the one place this rule is said out loud:
            most-specific-wins means a section attachment silently replaces
            whatever is checked above, with no other signal that it
            happened. C-1: `/knowledge/resolve` cannot answer this by itself
            (it is only ever asked about `homeworkId`, never a `sectionId`),
            so `sectionOverride` above is computed from the attachment list
            this form already loads, and a failed load of THAT is what this
            note now reports on -- staying silent here would read as
            "nothing overrides this", which may not be true. */}
        {homeworkId && attachments.error && (
          <p className="admin-inline-note">
            Could not check whether a section overrides this — try again before relying on what's checked above.
          </p>
        )}
        {homeworkId && !attachments.error && sectionOverride && (
          <p className="admin-inline-note">
            A section overrides this homework's knowledge — those sections ground on their own
            collection instead of this one.
          </p>
        )}
        {/* The homework/none-level explanations only ever describe what
            applies where no section overrides it, and only once we know
            that -- both resolution's own load and the attachment check
            above have to have succeeded first. */}
        {homeworkId && !attachments.error && !sectionOverride && resolution.error && (
          <p className="admin-inline-note">
            Could not check what this homework's knowledge resolves to — try again before relying on what's checked above.
          </p>
        )}
        {homeworkId && !attachments.error && !sectionOverride && !resolution.error && resolution.data?.level === "homework" && (
          <p className="admin-inline-note">
            This homework's own attachments are in effect — no section overrides them.
          </p>
        )}
        {homeworkId && !attachments.error && !sectionOverride && !resolution.error && resolution.data?.level === "none" && (
          <p className="admin-inline-note">
            Nothing attached, so the tutor answers with no course materials.
          </p>
        )}
      </fieldset>

      <fieldset className="admin-form-group">
        <legend>Publish</legend>
        {/* The checkbox's own text and its qualifier are separate lines now.
            Inline, "Published" and "Release at (optional, future only)" ran
            together into one unreadable run of text. */}
        <label className="admin-form-check">
          <input type="checkbox" {...register("publish")} />
          <span className="admin-form-check__label">Published</span>
        </label>
        <div className="admin-form-field">
          <label htmlFor="hw-released-at">Release at</label>
          <input id="hw-released-at" type="datetime-local" {...register("releasedAt")} />
          <p className="admin-form-hint">Optional. Must be in the future.</p>
        </div>
      </fieldset>

      <fieldset className="admin-form-group">
        <legend>Visibility</legend>
        <label className="admin-form-check">
          <input type="checkbox" {...register("hidden")} />
          <span className="admin-form-check__label">
            Hidden
            <span>Pulled from student view regardless of publish state.</span>
          </span>
        </label>
        <div className="admin-form-field">
          <label htmlFor="hw-expires-at">Expires at</label>
          <input id="hw-expires-at" type="datetime-local" {...register("expiresAt")} />
          {/* #328: "auto-hides once passed" never explained how this differs
              from the due date, and the two are easy to conflate. Expiry
              outranks every other state in deriveHomeworkStatus, so it is the
              one field here that can silently remove a whole class's access. */}
          <p className="admin-form-hint">
            Optional, and <strong>not</strong> the due date. Once it passes the homework is hidden from students
            entirely — including their own submitted work and tutor conversations. Leave empty unless you
            mean to withdraw access.
          </p>
        </div>
      </fieldset>

      {fields.map((field, index) => (
        <fieldset key={field.id} className="admin-form-record" aria-labelledby={`section-${index}-legend`}>
          {/* Numbered like the list view's HW-001 chip, so a section reads as
              a record rather than as browser fieldset chrome. */}
          <legend id={`section-${index}-legend`}>
            SEC · {String(index + 1).padStart(3, "0")}
          </legend>

          <div className="admin-form-field">
            <label htmlFor={`section-${index}-title`}>Section title</label>
            <input id={`section-${index}-title`} aria-label="Section title" {...register(`sections.${index}.title`, { required: true })} />
          </div>

          <div className="admin-form-field">
            <label htmlFor={`section-${index}-type`}>Section type</label>
            <select id={`section-${index}-type`} aria-label="Section type" {...register(`sections.${index}.type`)}>
              <option value="conversation">Conversation</option>
              <option value="non_interactive">Question (student types an answer)</option>
            </select>
          </div>

          <div className="admin-form-field">
            <label htmlFor={`section-${index}-content`}>Section content</label>
            <textarea id={`section-${index}-content`} aria-label="Section content" {...register(`sections.${index}.content`, { required: true })} />
            <p className="admin-form-hint">
              Markdown. This is the problem statement the student sees, and the context the AI tutor works from.
            </p>
            <div className="admin-markdown-preview" aria-label={`Section ${index + 1} content preview`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{watch(`sections.${index}.content`) || ""}</ReactMarkdown>
            </div>
          </div>

          <div className="admin-form-field">
            <label htmlFor={`section-${index}-solution`}>Solution</label>
            <textarea id={`section-${index}-solution`} aria-label="Section solution" {...register(`sections.${index}.solutionContent`)} />
            <p className="admin-form-hint">
              Optional. Never shown to students — visible only to graders holding the solutions capability.
            </p>
            <div className="admin-markdown-preview" aria-label={`Section ${index + 1} solution preview`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{watch(`sections.${index}.solutionContent`) || ""}</ReactMarkdown>
            </div>
          </div>

          <Button
            type="button"
            variant="danger"
            className="admin-form-record__remove"
            aria-label="Remove section"
            onClick={() => {
              // #328: the old copy ("cannot be undone until you save") read as
              // "it CAN be undone after you save" -- the opposite of the truth
              // -- and never mentioned the student conversations that go with it.
              if (window.confirm(`Remove section ${index + 1}? It will be deleted when you save this homework, along with any student conversations in it.`)) remove(index);
            }}
          >
            Remove section
          </Button>
        </fieldset>
      ))}

      {errors.sections && <p role="alert" className="admin-field-error">At least 1 section is required</p>}

      <div className="admin-form-add">
        <Button type="button" onClick={() => append({ title: "", content: "", solutionContent: undefined, type: "conversation" })}>
          + Add section
        </Button>
      </div>

      {widgetFields.map((field, index) => (
        <fieldset key={field.id} className="admin-form-record" aria-labelledby={`widget-${index}-legend`}>
          <legend id={`widget-${index}-legend`}>
            WIDGET · {String(index + 1).padStart(3, "0")}
          </legend>

          <div className="admin-form-field">
            <label htmlFor={`widget-${index}-pre`}>Pre-section prompt</label>
            <input id={`widget-${index}-pre`} aria-label="Pre-section prompt" {...register(`widgets.${index}.prePrompt`, { required: true })} />
          </div>

          <div className="admin-form-field">
            <label htmlFor={`widget-${index}-post`}>Post-section prompt</label>
            <input id={`widget-${index}-post`} aria-label="Post-section prompt" {...register(`widgets.${index}.postPrompt`, { required: true })} />
          </div>

          <Button
            type="button"
            variant="danger"
            className="admin-form-record__remove"
            aria-label="Remove widget"
            /* Deliberately unconfirmed, and pinned by a test ("no confirmation
               required"). It reads as an inconsistency next to Remove section,
               but it is proportionality: a section carries the problem
               statement, the solution, and the student conversations held
               against it, while a widget is two prompt strings that may have
               been added seconds ago. Confirming the cheap one would be
               friction, not safety. */
            onClick={() => removeWidget(index)}
          >
            Remove widget
          </Button>
        </fieldset>
      ))}

      <div className="admin-form-add">
        <Button type="button" onClick={() => appendWidget({ prePrompt: "", postPrompt: "" })}>
          + Add progress widget
        </Button>
      </div>

      {/* No retry action here — the Save button below IS the retry, and a
          second "Try again" next to it would be two controls for one act. */}
      {submitError && (
        <AdminNotice
          eyebrow={submitError === SAVE_FAILED ? "Not saved" : "Check this form"}
          title={submitError}
          body={
            submitError === SAVE_FAILED
              ? "Your edits are still on screen and nothing was written to the server. Nothing is lost until you leave this page."
              : undefined
          }
        />
      )}

      {/* Save sits in its own ruled band. Inline, it rendered as
          "+ Add section+ Add progress widgetSave" -- the commitment carrying
          no more weight than the two controls that merely extend a list. */}
      <div className="admin-form-actions">
        {/* #317 review (#345 accessibility) -- carried across the #317/#363
            merge, where this branch's `disabled={isLoading}` regressed it.
            A native `disabled` drops Save out of the tab order mid-save, so
            a keyboard user loses their place and hears nothing. `loading`
            keeps Save focusable, sets aria-disabled/aria-busy, and merely
            refuses re-activation; the role="status" line gives AT something
            to announce while the save runs. */}
        <Button type="submit" variant="accent" loading={isLoading}>
          Save
        </Button>
        {isLoading && (
          <p className="sr-only" role="status">
            Saving homework…
          </p>
        )}
      </div>
    </form>
  );
}

/** Warns before navigating away with unsaved changes. Browser-native
 *  beforeunload only covers a hard reload/close; in-app navigation (the
 *  view-state switch in App.tsx, since there's no router) is guarded by the
 *  caller checking isDirty before calling onBack -- exposed here only for
 *  the reload/close case, which this hook alone can cover. */
function useUnsavedChangesGuard(isDirty: boolean) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => { if (isDirty) e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}
