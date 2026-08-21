/* --------------------------------------------------------------------------
   GradingPanel — recording a grade on one submitted section (#75).

   Design note. The AI draft is the interesting part of this screen and it is
   deliberately NOT the default path. The layout says so: the instructor's
   own score and feedback are the form, and the draft is an optional block
   that fills those fields in when asked. Nothing is submitted on the
   instructor's behalf, and the button that produces a draft is visibly not
   the button that records a grade.

   That is the UI half of the rule the schema enforces: a grade is in force
   only if a human wrote it. The server stores a draft as graded_by_ai, which
   is inert; this screen makes that legible rather than restating it as a
   warning nobody reads.

   The history is on the page, not behind a toggle. A regrade supersedes
   rather than overwrites, and an instructor looking at a changed score needs
   to see what it changed from -- that is the question a grade dispute opens
   with.
   -------------------------------------------------------------------------- */

import { useCallback, useState } from "react";
import { Sparkle, Warning } from "@phosphor-icons/react";
import type { GradeDraftPayload, GradePayload } from "@llteacher/ui/api";
import { PageHeader } from "../components/PageHeader";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient, ApiError } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";

const DEFAULT_MAX_SCORE = 100;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function GradingPanel({
  courseId,
  submissionId,
  studentName,
  sectionTitle,
  onBack,
}: {
  courseId: string;
  submissionId: string;
  studentName: string;
  sectionTitle: string;
  onBack: () => void;
}) {
  const [score, setScore] = useState("");
  const [maxScore, setMaxScore] = useState(String(DEFAULT_MAX_SCORE));
  const [feedback, setFeedback] = useState("");
  /** Set when the instructor started from a draft, so the saved grade can
   *  record that provenance -- materially different from an independently
   *  written one, for a score a student may dispute. */
  const [fromDraftId, setFromDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GradeDraftPayload | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  /** #361: the field values as of the last successful save, so an unchanged
   *  form cannot be submitted again. Null until something has been saved. */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });

  const announce = useCallback(
    (text: string) => setLive((prev) => ({ text, nonce: prev.nonce + 1 })),
    [],
  );

  const grades = useApiResource(
    (opts) => apiClient.grades.list(courseId, submissionId, opts),
    [courseId, submissionId],
    {
      announce,
      loadingMessage: "Loading grades…",
      describeResult: (result) => {
        const inForce = result.grades.find((g) => g.isCurrent);
        if (!inForce) return "Not graded yet.";
        return inForce.score === null
          ? "Graded with written feedback and no mark."
          : `Currently graded ${inForce.score} out of ${inForce.maxScore}.`;
      },
    },
  );

  const requestDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    setError(null);
    announce("Drafting a grade…");
    try {
      const result = await apiClient.grades.requestDraft(courseId, submissionId, { signal: null });
      setDraft(result);
      announce("A draft is ready. Review it before saving.");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Could not draft a grade for this submission. Grade it directly.";
      setError(message);
      announce(message);
    } finally {
      setDrafting(false);
    }
  }, [courseId, submissionId, drafting, announce]);

  /** Copies the draft into the instructor's own fields. Explicit, and named
   *  "Use this draft" rather than happening automatically: the moment the
   *  numbers appear in the form is the moment the instructor takes
   *  responsibility for them, and that should be an act. */
  const adoptDraft = useCallback(() => {
    if (!draft) return;
    if (draft.score !== null) {
      setScore(String(draft.score));
      setMaxScore(String(draft.maxScore));
    }
    setFeedback(draft.rationale);
    setFromDraftId(draft.draftGradeId);
    announce("Draft copied into the grade. Edit it before saving.");
  }, [draft, announce]);

  const save = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (saving) return;

      const hasScore = score.trim() !== "";
      const parsedScore = hasScore ? Number(score) : null;
      const parsedMax = hasScore ? Number(maxScore) : null;
      if (hasScore && (!Number.isFinite(parsedScore!) || !Number.isFinite(parsedMax!) || parsedMax! <= 0)) {
        setError("Enter a score and a total greater than zero.");
        return;
      }
      if (hasScore && (parsedScore! < 0 || parsedScore! > parsedMax!)) {
        setError(`Score must be between 0 and ${parsedMax}.`);
        return;
      }
      if (!hasScore && !feedback.trim()) {
        setError("Enter a score, written feedback, or both.");
        return;
      }

      setSaving(true);
      setError(null);
      announce("Saving the grade…");
      try {
        await apiClient.grades.save(
          courseId,
          submissionId,
          {
            score: parsedScore,
            maxScore: parsedMax,
            feedback,
            supersedesGradeId: fromDraftId,
          },
          { signal: null },
        );
        announce("Grade saved.");
        setFromDraftId(null);
        setDraft(null);
        /* #361: the entry fields keep their values -- an instructor wants to
           see what they just recorded -- but `savedSnapshot` marks them as
           matching the grade now in force, which disables submit until
           something changes. Clearing the form instead would hide the
           result at the moment it is most wanted; leaving submit live made a
           duplicate grade one stray click away, and since grades are
           insert-only that duplicate is permanent history. */
        setSavedSnapshot(`${score}|${maxScore}|${feedback}`);
        grades.reload();
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Could not save that grade.";
        setError(message);
        announce(message);
      } finally {
        setSaving(false);
      }
    },
    [courseId, submissionId, score, maxScore, feedback, fromDraftId, saving, grades, announce],
  );

  const history = grades.data?.grades ?? [];
  const current = history.find((g) => g.isCurrent);
  const unchangedSinceSave = savedSnapshot === `${score}|${maxScore}|${feedback}`;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        All submissions
      </button>

      <PageHeader
        eyebrow="GRADING"
        title={studentName}
        subtitle={sectionTitle}
        actions={
          current ? (
            <span className="admin-grade-current">
              {current.score === null ? "Feedback only" : `${current.score} / ${current.maxScore}`}
            </span>
          ) : undefined
        }
      />

      <div className="admin-visually-hidden" role="status" aria-live="polite">
        <span key={live.nonce}>{live.text}</span>
      </div>

      {error && (
        <div className="admin-alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>{error}</span>
        </div>
      )}

      <form className="admin-form" onSubmit={save}>
        <fieldset className="admin-form-group">
          <legend>Your grade</legend>

          <div className="admin-grade-score">
            <div className="admin-form-field">
              <label htmlFor="grade-score">Score</label>
              <input
                id="grade-score"
                type="number"
                inputMode="decimal"
                value={score}
                onChange={(e) => setScore(e.target.value)}
              />
            </div>
            <span className="admin-grade-score__of" aria-hidden="true">
              /
            </span>
            <div className="admin-form-field">
              <label htmlFor="grade-max">Out of</label>
              <input
                id="grade-max"
                type="number"
                inputMode="decimal"
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
              />
            </div>
          </div>
          <p className="admin-form-hint">
            Leave the score blank to record written feedback with no mark. A score always needs the
            total it is out of — a number with no scale is unreadable a term later.
          </p>

          <div className="admin-form-field">
            <label htmlFor="grade-feedback">Feedback</label>
            <textarea
              id="grade-feedback"
              rows={6}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <p className="admin-form-hint">
              Written for the student. Saving records a new grade rather than editing the last one,
              so the history below is kept.
            </p>
          </div>
        </fieldset>

        <div className="admin-form-actions">
          <button
            type="submit"
            className="admin-button admin-button--primary"
            disabled={saving || unchangedSinceSave}
          >
            {saving ? "Saving…" : unchangedSinceSave ? "Saved" : current ? "Save a new grade" : "Save grade"}
          </button>
        </div>
      </form>

      {/* Deliberately AFTER the instructor's own form, and visibly separate.
          A draft is an optional assistant, not the primary path -- putting
          it first would make the instructor's job reviewing a machine's
          work rather than doing their own. */}
      <section className="admin-draft" aria-labelledby="draft-heading">
        <h2 className="admin-accession__eyebrow" id="draft-heading">
          <Sparkle size={13} weight="regular" aria-hidden="true" /> AI-assisted draft
        </h2>

        {!draft ? (
          <>
            <p className="admin-accession__hint">
              Reads this student&apos;s conversation and proposes a score and a rationale. It is
              never recorded as a grade — you copy it into the fields above, edit it, and save it
              yourself.
            </p>
            <button
              type="button"
              className="admin-button"
              disabled={drafting}
              onClick={() => void requestDraft()}
            >
              {drafting ? "Reading the conversation…" : "Draft a grade"}
            </button>
          </>
        ) : (
          <div className="admin-draft__result">
            <p className="admin-draft__score">
              {draft.score === null ? (
                <span className="admin-muted">No score proposed</span>
              ) : (
                <>
                  {draft.score} <span className="admin-muted">/ {draft.maxScore}</span>
                </>
              )}
              <span className="admin-draft__model">{draft.modelName}</span>
            </p>
            <p className="admin-draft__rationale">{draft.rationale}</p>
            <div className="admin-form-actions admin-form-actions--inline">
              <button type="button" className="admin-button" onClick={adoptDraft}>
                Use this draft
              </button>
              <button type="button" className="admin-link-button" onClick={() => setDraft(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="admin-grade-history" aria-labelledby="history-heading">
        <h2 className="admin-accession__eyebrow" id="history-heading">
          Grade history
        </h2>

        {grades.loading ? (
          <ViewLoading label="Loading grades…" />
        ) : grades.error ? (
          <ViewError
            error={grades.error}
            onRetry={grades.reload}
            detail={`GET /api/courses/${courseId}/submissions/${submissionId}/grades`}
          />
        ) : history.length === 0 ? (
          <p className="admin-accession__hint">This submission has not been graded yet.</p>
        ) : (
          <ol className="admin-accession__ledger">
            {history.map((g: GradePayload) => (
              <li
                key={g.id}
                className={
                  g.isCurrent
                    ? "admin-accession__entry admin-accession__entry--ok"
                    : "admin-accession__entry admin-accession__entry--neutral"
                }
              >
                <span className="admin-accession__netid">
                  {g.score === null ? "—" : `${g.score} / ${g.maxScore}`}
                </span>
                <span className="admin-accession__outcome">
                  {/* An AI row is never "current", however recent. That is
                      the rule, shown rather than explained. */}
                  {g.graderType === "ai" ? "Draft" : g.isCurrent ? "In force" : "Superseded"}
                </span>
                <span className="admin-accession__detail">
                  {g.graderType === "ai" ? "AI draft" : g.graderName || "Instructor"} ·{" "}
                  {formatWhen(g.createdAt)}
                  {g.supersedesGradeId && " · from a draft"}
                  {g.feedback && (
                    <>
                      <br />
                      {g.feedback}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
