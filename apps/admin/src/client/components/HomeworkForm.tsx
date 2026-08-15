import { useEffect, useState, type FormEvent } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Input } from "@llteacher/ui";
import type { LLMConfig, SectionDetail } from "../lib/fixtures";
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
  llmConfigs: LLMConfig[];
  isLoading?: boolean;
}

const MAX_SECTIONS = 20;

/* `submitError` carries two unrelated kinds of message: this one (the network
   save actually failed) and form-shape complaints like "No more than 20
   sections". Only the former earns the reassurance copy about unsaved edits,
   so the render branch compares against this constant rather than dressing
   every submit error as a server failure. */
const SAVE_FAILED = "Failed to save homework. Please try again.";

export function HomeworkForm({ initialData, onSubmit, llmConfigs, isLoading }: HomeworkFormProps) {
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
  const { fields, append, remove } = useFieldArray({ control, name: "sections" });
  const { fields: widgetFields, append: appendWidget, remove: removeWidget } = useFieldArray({ control, name: "widgets" });

  useUnsavedChangesGuard(isDirty);

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
          {llmConfigs.map((cfg) => <option key={cfg.id} value={cfg.id}>{cfg.name}</option>)}
        </select>
      </div>

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
        <Button type="submit" variant="accent" disabled={isLoading}>
          {isLoading ? "Saving…" : "Save"}
        </Button>
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
