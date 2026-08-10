/* --------------------------------------------------------------------------
   TaCapabilitiesView — per-course TA capability grants (#172).

   A TA's console access is deliberately narrow by default: they can read the
   submissions dashboard and individual student answers, but they cannot
   author content, and they cannot see model solutions or unreleased
   (draft/scheduled/hidden) homeworks unless an instructor grants it here,
   course by course.

   Local types mirror apps/web's CourseTaCapabilitiesResponse -- apps/admin
   never imports from apps/web (the only cross-package import anywhere in
   apps/admin/src is @llteacher/ui), same convention as SubmissionsView.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useState } from "react";
import { Users, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";

export interface TaCapabilities {
  membershipId: string;
  userId: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

export type TaCapabilitiesViewProps = {
  courseId: string;
  /** False for a TA viewing this surface. Granting is authoring-tier
      authority -- a TA must never widen their own or a peer's access -- so
      the toggles render read-only rather than the view being hidden. */
  canAuthor?: boolean;
};

export function TaCapabilitiesView({ courseId, canAuthor = true }: TaCapabilitiesViewProps) {
  const [tas, setTas] = useState<TaCapabilities[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTas(null);
    setLoadError(false);
    fetch(`/api/courses/${courseId}/tas`)
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json() as Promise<{ tas: TaCapabilities[] }>;
      })
      .then((data) => {
        if (!cancelled) setTas(Array.isArray(data.tas) ? data.tas : []);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    // Guards against a resolved fetch writing state after the course
    // changed or the view unmounted (#123's pattern).
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const toggle = useCallback(
    async (ta: TaCapabilities, field: "canViewSolutions" | "canViewDrafts") => {
      const next = !ta[field];
      setSavingId(ta.membershipId);
      setSaveError(null);
      try {
        const res = await fetch(`/api/courses/${courseId}/tas/${ta.membershipId}/capabilities`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [field]: next }),
        });
        if (!res.ok) throw new Error("failed");
        const updated = (await res.json()) as TaCapabilities;
        // Trust the server's echoed row rather than the optimistic value --
        // it is the authority on what was actually persisted.
        setTas((prev) =>
          prev
            ? prev.map((t) => (t.membershipId === updated.membershipId ? updated : t))
            : prev,
        );
      } catch {
        setSaveError("Could not update that permission. Please try again.");
      } finally {
        setSavingId(null);
      }
    },
    [courseId],
  );

  if (loadError) {
    return (
      <div className="admin-view">
        <p role="alert">Failed to load teaching assistants for this course.</p>
      </div>
    );
  }
  if (!tas) return null;

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="TEACHING ASSISTANTS"
        title="TA permissions"
        subtitle="TAs can always read the submissions dashboard and student answers. Model solutions and unreleased homeworks are granted per course."
      />

      {saveError && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{saveError}</span>
        </div>
      )}

      {tas.length === 0 ? (
        <div className="admin-empty">
          <Users size={22} weight="regular" aria-hidden="true" />
          <p>No teaching assistants are assigned to this course yet.</p>
        </div>
      ) : (
        <section className="admin-record-list" aria-label="Teaching assistant permissions">
          <header className="admin-submission-row admin-submission-row--head" aria-hidden="true">
            <div className="admin-submission-row__name">Teaching assistant</div>
            <div className="admin-submission-row__status">Model solutions</div>
            <div className="admin-submission-row__status">Unreleased homeworks</div>
          </header>

          {tas.map((ta) => (
            <article key={ta.membershipId} className="admin-submission-row">
              <div className="admin-submission-row__name">
                <span className="admin-submission-row__name-label">{ta.userId}</span>
              </div>
              <div className="admin-submission-row__status">
                <CapabilityToggle
                  checked={ta.canViewSolutions}
                  disabled={!canAuthor || savingId === ta.membershipId}
                  label={`Allow model solutions for ${ta.userId}`}
                  onChange={() => toggle(ta, "canViewSolutions")}
                />
              </div>
              <div className="admin-submission-row__status">
                <CapabilityToggle
                  checked={ta.canViewDrafts}
                  disabled={!canAuthor || savingId === ta.membershipId}
                  label={`Allow unreleased homeworks for ${ta.userId}`}
                  onChange={() => toggle(ta, "canViewDrafts")}
                />
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function CapabilityToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="admin-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
      <span className="admin-toggle__label">{checked ? "Allowed" : "Not allowed"}</span>
    </label>
  );
}
