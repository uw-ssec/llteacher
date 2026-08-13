import { useEffect, useState, type FormEvent } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Input } from "@llteacher/ui";
import type { SectionDetail } from "../lib/fixtures";
import { computeSectionDiff, type FormSection } from "../lib/computeSectionDiff";

/** The picker only ever renders an id + a label -- decoupled from the full
 *  fixtures.LLMConfig shape (which models the LLM-configs catalog page's
 *  row, not what a dropdown needs) so a real, server-fetched config summary
 *  (server/routes/llmConfigs.ts) can be mapped in without dragging along
 *  fields (recordNumber, basePromptPreview, ...) it doesn't have. */
export interface LLMConfigOption {
  id: string;
  name: string;
}

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
  llmConfigs: LLMConfigOption[];
  isLoading?: boolean;
}

const MAX_SECTIONS = 20;

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
      setSubmitError("Failed to save homework. Please try again.");
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
    <form onSubmit={submit} noValidate>
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
        {errors.dueDate && <p role="alert">{errors.dueDate.message}</p>}
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-llm-config">LLM config</label>
        <select id="hw-llm-config" {...register("llmConfigId")}>
          <option value="">(course/org default)</option>
          {llmConfigs.map((cfg) => <option key={cfg.id} value={cfg.id}>{cfg.name}</option>)}
        </select>
      </div>

      <fieldset>
        <legend>Publish</legend>
        <label>
          <input type="checkbox" {...register("publish")} />
          Published
        </label>
        <label htmlFor="hw-released-at">Release at (optional, future only)</label>
        <input id="hw-released-at" type="datetime-local" {...register("releasedAt")} />
      </fieldset>

      <fieldset>
        <legend>Visibility</legend>
        <label>
          <input type="checkbox" {...register("hidden")} />
          Hidden (pulled from student view regardless of publish state)
        </label>
        <label htmlFor="hw-expires-at">Expires at (optional — auto-hides once passed)</label>
        <input id="hw-expires-at" type="datetime-local" {...register("expiresAt")} />
      </fieldset>

      {fields.map((field, index) => (
        <fieldset key={field.id} aria-labelledby={`section-${index}-legend`}>
          <legend id={`section-${index}-legend`}>Section {index + 1}</legend>
          <label htmlFor={`section-${index}-title`}>Section title</label>
          <input id={`section-${index}-title`} aria-label="Section title" {...register(`sections.${index}.title`, { required: true })} />
          <label htmlFor={`section-${index}-type`}>Section type</label>
          <select id={`section-${index}-type`} aria-label="Section type" {...register(`sections.${index}.type`)}>
            <option value="conversation">Conversation</option>
            <option value="non_interactive">Question (student types an answer)</option>
          </select>
          <label htmlFor={`section-${index}-content`}>Section content</label>
          <textarea id={`section-${index}-content`} aria-label="Section content" {...register(`sections.${index}.content`, { required: true })} />
          <div className="admin-markdown-preview" aria-label={`Section ${index + 1} content preview`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{watch(`sections.${index}.content`) || ""}</ReactMarkdown>
          </div>
          <label htmlFor={`section-${index}-solution`}>Solution (optional)</label>
          <textarea id={`section-${index}-solution`} aria-label="Section solution" {...register(`sections.${index}.solutionContent`)} />
          <div className="admin-markdown-preview" aria-label={`Section ${index + 1} solution preview`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{watch(`sections.${index}.solutionContent`) || ""}</ReactMarkdown>
          </div>
          <Button
            type="button"
            variant="danger"
            aria-label="Remove section"
            onClick={() => {
              if (window.confirm(`Remove section ${index + 1}? This cannot be undone until you save.`)) remove(index);
            }}
          >
            Remove section
          </Button>
        </fieldset>
      ))}

      {errors.sections && <p role="alert">At least 1 section is required</p>}

      <Button type="button" onClick={() => append({ title: "", content: "", solutionContent: undefined, type: "conversation" })}>
        + Add section
      </Button>

      {widgetFields.map((field, index) => (
        <fieldset key={field.id} aria-labelledby={`widget-${index}-legend`}>
          <legend id={`widget-${index}-legend`}>Progress Widget {index + 1}</legend>
          <label htmlFor={`widget-${index}-pre`}>Pre-section prompt</label>
          <input id={`widget-${index}-pre`} aria-label="Pre-section prompt" {...register(`widgets.${index}.prePrompt`, { required: true })} />
          <label htmlFor={`widget-${index}-post`}>Post-section prompt</label>
          <input id={`widget-${index}-post`} aria-label="Post-section prompt" {...register(`widgets.${index}.postPrompt`, { required: true })} />
          <Button
            type="button"
            variant="danger"
            aria-label="Remove widget"
            onClick={() => removeWidget(index)}
          >
            Remove widget
          </Button>
        </fieldset>
      ))}

      <Button type="button" onClick={() => appendWidget({ prePrompt: "", postPrompt: "" })}>
        + Add progress widget
      </Button>

      {submitError && <p role="alert">{submitError}</p>}

      <Button type="submit" variant="accent" disabled={isLoading}>Save</Button>
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
