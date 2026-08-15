/* --------------------------------------------------------------------------
   LLMConfigsView — the catalog of LLM tutor configurations.

   Each row is a CFG·xxx record showing model, temperature, token cap,
   and a one-line prompt preview. The default config is anchored with a
   small Heritage Gold "★ default" marker rather than a chip-shaped
   badge so the gold-accent system stays consistent (gold == AI-side
   authority across both apps).
   -------------------------------------------------------------------------- */

import { Plus, Sparkle, Thermometer } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { ListControls } from "@llteacher/ui";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";
import type { LLMConfig } from "../lib/fixtures";

export type LLMConfigsViewProps = {
  configs: LLMConfig[];
  onOpenConfig: (id: string) => void;
  onNewConfig: () => void;
};

type Sort = "default" | "name" | "model";

const SORT_OPTIONS = [
  { value: "default", label: "Default first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "model", label: "Model" },
];

export function LLMConfigsView({
  configs,
  onOpenConfig,
  onNewConfig,
}: LLMConfigsViewProps) {
  const activeCount = configs.filter((c) => c.isActive).length;
  const defaultConfig = configs.find((c) => c.isDefault);
  const [sort, setSort] = useState<Sort>("default");

  /* Sort only -- no search box and no filter chips. A course runs two to six
     of these, and a search field over a list that short is not neutral
     chrome: it tells the reader the list is long enough to need searching,
     every time they open the page. The controls each list gets are scaled to
     the list, which is also why Submissions gets all three. */
  const visible = useMemo(() => {
    return [...configs].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "model") return a.modelName.localeCompare(b.modelName);
      // "Default first" is the reading order that matches how these are
      // used: one config backs most homeworks and the rest are exceptions.
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [configs, sort]);

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`LLM CONFIGS · ${configs.length} RECORDS`}
        title="Tutor configurations"
        subtitle="Model, prompt, and inference parameters that back the AI tutor across this course."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            onClick={onNewConfig}
          >
            <Plus size={14} weight="bold" aria-hidden="true" />
            New configuration
          </button>
        }
      />

      <div className="admin-stat-row" role="list" aria-label="Configuration summary">
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Records</div>
          <div className="admin-stat__value">{configs.length}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Active</div>
          <div className="admin-stat__value">{activeCount}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Default</div>
          <div className="admin-stat__value admin-stat__value--text">
            {defaultConfig ? defaultConfig.name : <span className="admin-muted">none</span>}
          </div>
        </div>
      </div>

      {/* Below the threshold where ordering is a task at all, the control is
          more chrome than help. */}
      {configs.length > 2 && (
        <ListControls
          sort={{ value: sort, onChange: (v) => setSort(v as Sort), label: "Sort", options: SORT_OPTIONS }}
          summary={`${configs.length} ${configs.length === 1 ? "configuration" : "configurations"}`}
        />
      )}

      <section className="admin-record-list" aria-label="LLM configurations">
        {visible.map((cfg, idx) => (
          <article
            key={cfg.id}
            className="admin-record-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 55}ms` }}
          >
            <div className="admin-record-row__id">
              <RecordId prefix="CFG" index={cfg.recordNumber} />
            </div>

            <div className="admin-record-row__body">
              <button
                type="button"
                className="admin-record-row__title"
                onClick={() => onOpenConfig(cfg.id)}
              >
                {cfg.name}
                {cfg.isDefault && (
                  <span className="admin-default-mark" aria-label="Default configuration">
                    ★ default
                  </span>
                )}
              </button>
              {/* Status leads the meta line, matching the homework row. It is a
                  record attribute, not an action, and parking it in the third
                  grid column pushed the real actions onto an implicit second
                  row -- which is why "Open" rendered below-left here while the
                  homework row's actions sat right. */}
              <div className="admin-record-row__meta">
                <StatusBadge kind={cfg.isActive ? "active" : "inactive"}>
                  {cfg.isActive ? "active" : "inactive"}
                </StatusBadge>
                <span className="admin-record-row__meta-chip admin-record-row__meta-chip--mono">
                  <Sparkle size={12} weight="regular" aria-hidden="true" />
                  {cfg.modelName}
                </span>
                <span className="admin-record-row__meta-chip">
                  <Thermometer size={12} weight="regular" aria-hidden="true" />
                  temp {cfg.temperature.toFixed(1)}
                </span>
                <span className="admin-record-row__meta-chip">
                  {cfg.maxCompletionTokens.toLocaleString()} max tokens
                </span>
              </div>
              <p className="admin-record-row__desc admin-record-row__desc--quote">
                <span className="admin-prompt-quote" aria-hidden="true">"</span>
                {cfg.basePromptPreview}
                <span className="admin-prompt-quote" aria-hidden="true">"</span>
              </p>
            </div>

            <div className="admin-record-row__actions">
              <button
                type="button"
                className="admin-button admin-button--ghost"
                onClick={() => onOpenConfig(cfg.id)}
              >
                Open
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
