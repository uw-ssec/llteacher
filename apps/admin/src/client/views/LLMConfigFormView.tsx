/* --------------------------------------------------------------------------
   LLMConfigFormView — authoring a tutor configuration.

   Serves both "New" and "Edit", the way HomeworkForm does, because the
   fields are identical and the only difference is whether they start
   populated.

   The design problem here is not layout, it is legibility. A tutor config
   is four pedagogical decisions wearing technical clothes:

     · which model answers the student
     · how consistent it is between students        (temperature)
     · how much it is allowed to say in one turn    (max completion tokens)
     · what it is told it is                        (base prompt)

   An instructor asked to type `0.7` into a number input has no way to
   reason about it, and the number is not the point -- the behaviour is. So
   temperature and the token budget render as calibrated scales with
   pedagogical anchors, and the value is shown in mono beside them rather
   than being the thing you edit. The base prompt gets the prose treatment
   section content got in #331, because it is the tutor's voice, not a
   setting.

   CREDENTIALS ARE DELIBERATELY NOT COLLECTED HERE. See #332: the platform
   gateway needs no key from an instructor, which is the whole point of it.
   An instructor-supplied credential requires the `secret_ref` allowlist in
   #323 first -- without it, an instructor choosing which env binding to
   read is choosing from an environment that holds ENCRYPTION_KEY and
   SESSION_SECRET. The custom-provider option is shown, disabled, with the
   reason stated, rather than hidden: an instructor who needs it should know
   it is coming, and a reviewer should see the gate.
   -------------------------------------------------------------------------- */

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "../components/PageHeader";
import { AdminNotice } from "../components/AdminNotice";
import type { LLMConfig } from "../lib/fixtures";

export interface LLMConfigFormValues {
  name: string;
  provider: "platform" | "custom";
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface LLMConfigFormViewProps {
  /** Present when editing; absent when creating. */
  initialConfig?: LLMConfig;
  /** Models the gateway currently serves. Empty until #333's discovery
   *  endpoint lands, which is why this degrades to a free-text field
   *  rather than an empty select the instructor cannot escape. */
  availableModels?: string[];
  onSave: (values: LLMConfigFormValues) => Promise<void>;
  onCancel: () => void;
}

/* Anchors, not adjectives. Each end says what the student experiences, so
   the instructor is choosing a behaviour rather than a number. */
const TEMPERATURE_ANCHORS = { low: "Consistent", high: "Varied" };
const TOKEN_ANCHORS = { low: "Brief", high: "Expansive" };

const TEMPERATURE_HINT: Record<string, string> = {
  low: "Every student gets close to the same wording. Predictable, and easier to support when two students compare notes.",
  mid: "Some variation in phrasing between students, with the same substance. A reasonable default for most assignments.",
  high: "The tutor rephrases and improvises freely. Better for open-ended discussion, harder to reproduce when a student reports a problem.",
};

function temperatureBand(t: number): keyof typeof TEMPERATURE_HINT {
  if (t <= 0.4) return "low";
  if (t <= 0.9) return "mid";
  return "high";
}

/* Import limits. `accept` is a picker hint the OS lets you bypass with
   "All Files", so the extension is re-checked in code. The size cap is not
   about upload cost -- nothing is uploaded -- but about what a system prompt
   plausibly is: prose. A megabyte-scale file in this field is a mistake, and
   pasting it into a textarea would hang the tab before it ever reached a
   model. */
const PROMPT_FILE_EXTENSIONS = [".md", ".markdown"];
const MAX_PROMPT_BYTES = 128 * 1024;

/** ~4 characters per token is the usual rough conversion; stated as a range
 *  because an instructor should not read it as exact. */
function approxWords(tokens: number): string {
  const words = Math.round((tokens * 0.75) / 10) * 10;
  return `about ${words.toLocaleString()} words`;
}

export function LLMConfigFormView({
  initialConfig,
  availableModels = [],
  onSave,
  onCancel,
}: LLMConfigFormViewProps) {
  const isEdit = initialConfig !== undefined;

  const [values, setValues] = useState<LLMConfigFormValues>({
    name: initialConfig?.name ?? "",
    provider: "platform",
    modelName: initialConfig?.modelName ?? "",
    basePrompt: initialConfig?.basePromptPreview ?? "",
    temperature: initialConfig?.temperature ?? 0.7,
    maxCompletionTokens: initialConfig?.maxCompletionTokens ?? 1000,
    isDefault: initialConfig?.isDefault ?? false,
    isActive: initialConfig?.isActive ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /* Import feedback lives beside the field rather than in a toast: the
     instructor needs to know which file landed, and a transient message
     would be gone by the time they finish reading the prompt it produced. */
  const [importNotice, setImportNotice] = useState<
    { ok: true; text: string } | { ok: false; text: string } | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof LLMConfigFormValues>(key: K, v: LLMConfigFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const importPromptFile = async (file: File) => {
    setImportNotice(null);

    const name = file.name.toLowerCase();
    if (!PROMPT_FILE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      setImportNotice({
        ok: false,
        text: `${file.name} isn't a Markdown file. Choose a .md or .markdown file.`,
      });
      return;
    }
    if (file.size > MAX_PROMPT_BYTES) {
      setImportNotice({
        ok: false,
        text: `${file.name} is ${Math.round(file.size / 1024)} KB. A system prompt should be prose — the limit is ${MAX_PROMPT_BYTES / 1024} KB.`,
      });
      return;
    }

    /* Replacing is destructive and there is no undo, so ask first -- but only
       when there is something to lose. Confirming an import into an empty
       field would be friction for no safety. */
    if (
      values.basePrompt.trim() &&
      !window.confirm(
        `Replace the current base prompt with the contents of ${file.name}? What's in the field now will be lost.`,
      )
    ) {
      return;
    }

    try {
      const text = await file.text();
      if (!text.trim()) {
        setImportNotice({ ok: false, text: `${file.name} is empty.` });
        return;
      }
      set("basePrompt", text);
      setImportNotice({
        ok: true,
        text: `Loaded ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB). Edit it here — the file itself isn't linked or stored.`,
      });
    } catch {
      setImportNotice({ ok: false, text: `${file.name} couldn't be read.` });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(values);
    } catch {
      setSaveError("This configuration couldn't be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>
        Cancel
      </button>

      <PageHeader
        eyebrow="LLM CONFIG"
        title={isEdit ? "Edit configuration" : "New configuration"}
        subtitle="The model, voice, and limits behind the AI tutor for this course."
      />

      <form className="admin-form" onSubmit={submit} noValidate>
        <div className="admin-form-field">
          <label htmlFor="cfg-name">Name</label>
          <input
            id="cfg-name"
            type="text"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
          />
          <p className="admin-form-hint">
            How this configuration appears when picking one for a homework. Name it for what it
            does — &ldquo;Socratic default&rdquo;, not &ldquo;config 2&rdquo;.
          </p>
        </div>

        <fieldset className="admin-form-group">
          <legend>Model</legend>

          <label className="admin-form-check">
            <input
              type="radio"
              name="provider"
              checked={values.provider === "platform"}
              onChange={() => set("provider", "platform")}
            />
            <span className="admin-form-check__label">
              Platform gateway
              <span>
                UW SSEC&apos;s shared gateway. No API key needed — billing and credentials are
                handled for you.
              </span>
            </span>
          </label>

          {/* Shown disabled rather than hidden. An instructor who needs their
              own provider should know it is planned, and a reviewer should be
              able to see that the credential path is gated rather than
              forgotten. See #332 / #323. */}
          <label className="admin-form-check admin-form-check--disabled">
            <input type="radio" name="provider" disabled />
            <span className="admin-form-check__label">
              Your own provider
              <span>
                Not available yet. Bringing your own key needs credential handling that
                isn&apos;t built — tracked in #332.
              </span>
            </span>
          </label>

          <div className="admin-form-field">
            <label htmlFor="cfg-model">Model</label>
            {availableModels.length > 0 ? (
              <select
                id="cfg-model"
                value={values.modelName}
                onChange={(e) => set("modelName", e.target.value)}
              >
                <option value="">Select a model…</option>
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="cfg-model"
                type="text"
                value={values.modelName}
                onChange={(e) => set("modelName", e.target.value)}
                placeholder="e.g. google/gemma-4-31b-it:free"
              />
            )}
            <p className="admin-form-hint">
              {availableModels.length > 0
                ? "Models the gateway currently serves."
                : "The gateway's model list isn't wired up yet, so this is free text for now."}
            </p>
          </div>
        </fieldset>

        <fieldset className="admin-form-group">
          <legend>Behaviour</legend>

          {/* The two scales. The number is readout, not input -- an instructor
              is choosing how the tutor behaves, and the float is an
              implementation detail they should be able to ignore. */}
          <div className="admin-form-field">
            <label htmlFor="cfg-temperature">Consistency</label>
            <div className="admin-scale">
              <input
                id="cfg-temperature"
                className="admin-scale__input"
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={values.temperature}
                onChange={(e) => set("temperature", Number(e.target.value))}
                aria-describedby="cfg-temperature-hint"
              />
              <output className="admin-scale__value" htmlFor="cfg-temperature">
                {values.temperature.toFixed(1)}
              </output>
            </div>
            <div className="admin-scale__anchors" aria-hidden="true">
              <span>{TEMPERATURE_ANCHORS.low}</span>
              <span>{TEMPERATURE_ANCHORS.high}</span>
            </div>
            <p className="admin-form-hint" id="cfg-temperature-hint">
              {TEMPERATURE_HINT[temperatureBand(values.temperature)]}
            </p>
          </div>

          <div className="admin-form-field">
            <label htmlFor="cfg-tokens">Answer length limit</label>
            <div className="admin-scale">
              <input
                id="cfg-tokens"
                className="admin-scale__input"
                type="range"
                min={250}
                max={4000}
                step={50}
                value={values.maxCompletionTokens}
                onChange={(e) => set("maxCompletionTokens", Number(e.target.value))}
                aria-describedby="cfg-tokens-hint"
              />
              <output className="admin-scale__value" htmlFor="cfg-tokens">
                {values.maxCompletionTokens.toLocaleString()}
              </output>
            </div>
            <div className="admin-scale__anchors" aria-hidden="true">
              <span>{TOKEN_ANCHORS.low}</span>
              <span>{TOKEN_ANCHORS.high}</span>
            </div>
            <p className="admin-form-hint" id="cfg-tokens-hint">
              A ceiling on one reply — {approxWords(values.maxCompletionTokens)}. The tutor stops
              here even mid-sentence, so leave room for a worked explanation.
            </p>
          </div>
        </fieldset>

        <div className="admin-form-field">
          {/* The import control sits on the label row rather than under the
              textarea: it is an alternative way to fill this one field, so it
              belongs to the field's heading, not to the content below it. */}
          <div className="admin-form-field__header">
            <label htmlFor="cfg-prompt">Base prompt</label>
            {/* A <label> wrapping a visually-hidden-but-focusable input is the
                accessible file-picker pattern. `.sr-only` clips rather than
                display:none, which would drop the input out of the tab order
                entirely; the visible focus ring is painted via :focus-within
                on the wrapper, since the element actually holding focus is the
                one nobody can see. */}
            <label className="prompt-import">
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept=".md,.markdown,text/markdown"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  /* Clear the input regardless of outcome. A file input does
                     not fire change when the same path is picked twice, so
                     without this, fixing a file and re-importing it would
                     silently do nothing. */
                  e.target.value = "";
                  if (file) void importPromptFile(file);
                }}
              />
              <span className="prompt-import__face">Import .md</span>
            </label>
          </div>
          <textarea
            id="cfg-prompt"
            value={values.basePrompt}
            onChange={(e) => set("basePrompt", e.target.value)}
          />
          <p className="admin-form-hint">
            Markdown. This is what the tutor is told it is, before it ever sees a student. It sets
            the voice for every conversation this configuration backs. Write it here, or import a
            file you keep elsewhere.
          </p>
          {importNotice && (
            /* Assertive rather than polite: this replaces the whole field, and
               a screen-reader user who just triggered the picker needs to know
               it landed before they arrow back into the textarea. */
            <p
              className={`prompt-import__notice${importNotice.ok ? "" : " prompt-import__notice--error"}`}
              role="alert"
            >
              {importNotice.text}
            </p>
          )}
          <div className="admin-markdown-preview" aria-label="Base prompt preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{values.basePrompt}</ReactMarkdown>
          </div>
        </div>

        <fieldset className="admin-form-group">
          <legend>Availability</legend>

          <label className="admin-form-check">
            <input
              type="checkbox"
              checked={values.isDefault}
              onChange={(e) => set("isDefault", e.target.checked)}
            />
            <span className="admin-form-check__label">
              Course default
              <span>
                Used by any homework that doesn&apos;t pick its own. Setting this moves the default
                off whichever configuration currently holds it.
              </span>
            </span>
          </label>

          <label className="admin-form-check">
            <input
              type="checkbox"
              checked={values.isActive}
              onChange={(e) => set("isActive", e.target.checked)}
            />
            <span className="admin-form-check__label">
              Active
              <span>
                Inactive configurations stay on record but can&apos;t be selected for new
                homeworks.
              </span>
            </span>
          </label>
        </fieldset>

        {saveError && <AdminNotice eyebrow="Not saved" title={saveError} />}

        <div className="admin-form-actions">
          <button type="submit" className="admin-button admin-button--primary" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create configuration"}
          </button>
        </div>
      </form>
    </div>
  );
}
