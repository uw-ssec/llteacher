/* --------------------------------------------------------------------------
   The LLM-config screens, wired to the API (#31, #170, #98, #33).

   This is where the console stops reading `lib/fixtures.ts`. It owns the
   three config screens as one unit -- list, create, edit -- because they
   share the fetched collection: the edit form needs the org's OTHER configs
   for its fallback picker, and the list needs to reload after any write.
   Splitting them into three components with three fetches would mean three
   chances for them to disagree about what the org currently holds.
   -------------------------------------------------------------------------- */

import { useCallback, useState } from "react";
import type { LlmConfigPayload, LlmConfigWriteBody } from "@llteacher/ui/api";
import { LLMConfigsView } from "./LLMConfigsView";
import { LLMConfigFormView, type LLMConfigFormValues } from "./LLMConfigFormView";
import { ViewError, ViewLoading } from "../components/ViewState";
import { AdminNotice } from "../components/AdminNotice";
import { apiClient, ApiError } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";

export type ConfigScreen =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; configId: string };

/** The form speaks in its own vocabulary (a `provider` radio with one
 *  enabled option) and the API speaks in the schema's. One translation,
 *  here, rather than the form knowing about `llm_provider` enum values.
 *
 *  "platform" maps to openrouter because that IS the platform gateway --
 *  #332's decision. When instructor-supplied credentials land (#323), this
 *  is the function that grows a second branch. */
function toWriteBody(values: LLMConfigFormValues): LlmConfigWriteBody {
  return {
    name: values.name,
    provider: "openrouter",
    modelName: values.modelName,
    basePrompt: values.basePrompt,
    temperature: values.temperature,
    maxCompletionTokens: values.maxCompletionTokens,
    fallbackLlmConfigId: values.fallbackLlmConfigId,
    isActive: values.isActive,
    isDefault: values.isDefault,
  };
}

export function LLMConfigsDataLoader({
  courseId,
  screen,
  onScreenChange,
}: {
  courseId: string;
  screen: ConfigScreen;
  onScreenChange: (next: ConfigScreen) => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);

  const configs = useApiResource(
    (opts) => apiClient.llmConfigs.list(courseId, opts),
    [courseId],
  );

  const save = useCallback(
    async (values: LLMConfigFormValues, configId: string | null) => {
      setActionError(null);
      const body = toWriteBody(values);
      // Deliberately NOT caught here: LLMConfigFormView's own submit handler
      // turns a rejection into its inline "couldn't be saved" state and
      // keeps the form populated, which is #34's error-recovery
      // requirement. Swallowing it here would clear the form on failure.
      if (configId) await apiClient.llmConfigs.update(courseId, configId, body, { signal: null });
      else await apiClient.llmConfigs.create(courseId, body, { signal: null });
      configs.reload();
      onScreenChange({ kind: "list" });
    },
    [courseId, configs, onScreenChange],
  );

  const clone = useCallback(
    async (config: LlmConfigPayload) => {
      const name = window.prompt(
        `Name for the copy of “${config.name}”:`,
        `${config.name} (copy)`,
      );
      if (name === null) return;
      if (!name.trim()) {
        setActionError("Give the copy a name.");
        return;
      }
      setActionError(null);
      try {
        const created = await apiClient.llmConfigs.clone(courseId, config.id, name.trim(), {
          signal: null,
        });
        configs.reload();
        // Straight into the copy: cloning is how an instructor starts an
        // experiment, and the next thing they want is to change something.
        onScreenChange({ kind: "edit", configId: created.id });
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "Could not copy that configuration.");
      }
    },
    [courseId, configs, onScreenChange],
  );

  const deactivate = useCallback(
    async (config: LlmConfigPayload) => {
      if (
        !window.confirm(
          `Deactivate “${config.name}”?\n\nIt stays on record and any homework already using it keeps working, but it cannot be chosen for new homeworks. You can reactivate it later.`,
        )
      ) {
        return;
      }
      setActionError(null);
      try {
        await apiClient.llmConfigs.deactivate(courseId, config.id, { signal: null });
        configs.reload();
      } catch (err) {
        // The 409 for "this is the default" carries the server's own
        // sentence, which names the unblocking step -- far better than a
        // generic failure.
        setActionError(
          err instanceof ApiError ? err.message : "Could not deactivate that configuration.",
        );
      }
    },
    [courseId, configs],
  );

  const test = useCallback(
    async (configId: string, message: string) => {
      const result = await apiClient.llmConfigs.test(courseId, configId, message, { signal: null });
      return result.ok
        ? ({ ok: true, text: result.text, usage: result.usage } as const)
        : ({ ok: false, error: result.error } as const);
    },
    [courseId],
  );

  if (configs.loading) return <ViewLoading label="Loading configurations…" />;
  if (configs.error) {
    return (
      <ViewError
        error={configs.error}
        onRetry={configs.reload}
        detail={`GET /api/courses/${courseId}/llm-configs`}
      />
    );
  }

  const all = configs.data?.configs ?? [];
  const editing = screen.kind === "edit" ? all.find((c) => c.id === screen.configId) : undefined;

  if (screen.kind === "edit" && !editing) {
    // The list loaded and this id is not in it: deleted, or belonging to
    // another org. A dead form is worse than a stated fact.
    return (
      <AdminNotice
        eyebrow="Not available"
        title="That configuration no longer exists"
        body="It may have been removed since this page was opened."
        tone="denied"
        secondaryAction={{ label: "Back to configurations", onClick: () => onScreenChange({ kind: "list" }) }}
      />
    );
  }

  if (screen.kind === "create" || screen.kind === "edit") {
    return (
      <>
        {actionError && <AdminNotice eyebrow="Not saved" title={actionError} />}
        <LLMConfigFormView
          initialConfig={editing}
          siblings={all}
          onSave={(values) => save(values, editing?.id ?? null)}
          onCancel={() => onScreenChange({ kind: "list" })}
          // Editing only: there is nothing saved to test when creating, and
          // testing unsaved form values would answer a different question
          // than "will this work for my students".
          onTest={editing ? (message) => test(editing.id, message) : undefined}
        />
      </>
    );
  }

  return (
    <>
      {actionError && <AdminNotice eyebrow="Could not do that" title={actionError} />}
      <LLMConfigsView
        configs={all}
        onOpenConfig={(id) => onScreenChange({ kind: "edit", configId: id })}
        onNewConfig={() => onScreenChange({ kind: "create" })}
        onCloneConfig={clone}
        onDeactivateConfig={deactivate}
      />
    </>
  );
}
