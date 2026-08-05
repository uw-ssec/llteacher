import { useState, type FormEvent } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import type { LLMConfig, SectionDetail } from "../lib/fixtures";
import { computeSectionDiff, type FormSection } from "../lib/computeSectionDiff";

export interface HomeworkFormValues {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | undefined;
  sections: FormSection[];
  publish: boolean;
  releasedAt: string | undefined;
}

export interface HomeworkFormInitialData {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  sections: SectionDetail[];
  status: "draft" | "scheduled" | "active" | "past_due" | "archived";
  releasedAt: string | null;
}

export interface HomeworkFormProps {
  initialData?: HomeworkFormInitialData;
  onSubmit: (payload: {
    title: string; description: string; dueDate: string; llmConfigId?: string;
    sections: ReturnType<typeof computeSectionDiff>;
    publish: boolean; releasedAt?: string;
  }) => Promise<void>;
  llmConfigs: LLMConfig[];
  isLoading?: boolean;
}

const MAX_SECTIONS = 20;

export function HomeworkForm({ initialData, onSubmit, llmConfigs, isLoading }: HomeworkFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register, control, handleSubmit, formState: { errors, isDirty },
  } = useForm<HomeworkFormValues>({
    defaultValues: initialData
      ? {
          title: initialData.title, description: initialData.description, dueDate: initialData.dueDate,
          llmConfigId: initialData.llmConfigId ?? undefined,
          sections: initialData.sections.map((s) => ({ id: s.id, title: s.title, content: s.content, solutionContent: s.solutionContent })),
          publish: initialData.status !== "draft",
          releasedAt: initialData.releasedAt ?? undefined,
        }
      : { title: "", description: "", dueDate: "", llmConfigId: undefined, sections: [], publish: false, releasedAt: undefined },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "sections" });

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
    await onSubmit({
      title: values.title, description: values.description, dueDate: values.dueDate,
      llmConfigId: values.llmConfigId, sections: computeSectionDiff(sections),
      publish: values.publish, releasedAt: values.releasedAt,
    });
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
        <label htmlFor="hw-title">Title</label>
        <input id="hw-title" {...register("title", { required: "Title required" })} />
        {errors.title && <p role="alert">{errors.title.message}</p>}
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-description">Description</label>
        <textarea id="hw-description" {...register("description")} />
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-due-date">Due date</label>
        <input id="hw-due-date" type="datetime-local" {...register("dueDate", { required: "Due date required" })} />
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

      {fields.map((field, index) => (
        <fieldset key={field.id} aria-labelledby={`section-${index}-legend`}>
          <legend id={`section-${index}-legend`}>Section {index + 1}</legend>
          <label htmlFor={`section-${index}-title`}>Section title</label>
          <input id={`section-${index}-title`} aria-label="Section title" {...register(`sections.${index}.title`, { required: true })} />
          <label htmlFor={`section-${index}-content`}>Section content</label>
          <textarea id={`section-${index}-content`} aria-label="Section content" {...register(`sections.${index}.content`, { required: true })} />
          <label htmlFor={`section-${index}-solution`}>Solution (optional)</label>
          <textarea id={`section-${index}-solution`} aria-label="Section solution" {...register(`sections.${index}.solutionContent`)} />
          <button type="button" aria-label="Remove section" onClick={() => remove(index)}>Remove section</button>
        </fieldset>
      ))}

      {errors.sections && <p role="alert">At least 1 section is required</p>}
      {submitError && <p role="alert">{submitError}</p>}

      <button type="button" onClick={() => append({ title: "", content: "", solutionContent: undefined })}>
        + Add section
      </button>

      <button type="submit" disabled={isLoading}>Save</button>
    </form>
  );
}

/** Warns before navigating away with unsaved changes. Browser-native
 *  beforeunload only covers a hard reload/close; in-app navigation (the
 *  view-state switch in App.tsx, since there's no router) is guarded by the
 *  caller checking isDirty before calling onBack -- exposed here only for
 *  the reload/close case, which this hook alone can cover. */
function useUnsavedChangesGuard(isDirty: boolean) {
  useState(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => { if (isDirty) e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  });
}
