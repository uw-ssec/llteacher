import { useEffect, useId, useRef, useState } from "react";
import { Flag } from "@phosphor-icons/react";
import { AlertDialog } from "@llteacher/ui";
import type { FeedbackReason } from "../../shared/types";

/* --------------------------------------------------------------------------
   ResponseFeedback — the student's "flag this response" affordance (#90).

   Rendered per assistant turn via ConversationView's renderAiFeedbackSlot
   slot (packages/ui/src/components/ConversationView.tsx) -- only ever for
   a message that has already round-tripped through the persisted history
   (see that prop's own doc comment for why: a live-streaming turn's client-
   visible id is not yet the server's real message id). Lives in apps/web,
   not packages/ui, because it owns a real API call and app-specific
   business state -- packages/ui has no fetch/business-logic surface
   anywhere else either (compare ConversationListItem, also apps/web-local
   for the identical reason).

   Reuses AlertDialog (packages/ui) for the reason-picker rather than
   building a second modal/popover primitive -- the issue's own "unobtrusive
   UI per the design system" requirement is best served by the ONE
   accessible, focus-trapped dialog this app already has, not a bespoke
   one. `description` accepts arbitrary ReactNode, which is what makes the
   reason radios + comment textarea fit inside it unmodified.

   One flag per (message, student) is a server-enforced invariant (the
   response_feedback_message_student_uq unique index, db/schema/runtime.ts)
   -- this component does not re-fetch on mount to learn whether a past
   session already flagged this message (that would need a new GET-by-
   message endpoint this pilot-scale feature doesn't otherwise need); a
   flagged message shows as flaggable again after a reload, and a repeat
   submission simply 409s, which is handled the same as a genuine success
   (see handleSubmit's own comment). Keeping this in-session-only, rather
   than adding a lookup endpoint, is the deliberate "keep it small" scope
   call for a pilot instrument.
   -------------------------------------------------------------------------- */

const REASON_OPTIONS: { value: FeedbackReason; label: string }[] = [
  { value: "incorrect", label: "Incorrect" },
  { value: "gave_away_answer", label: "Gave away the answer" },
  { value: "confusing", label: "Confusing" },
  { value: "other", label: "Other" },
];

const MAX_COMMENT_CHARS = 2000;

export interface ResponseFeedbackProps {
  conversationId: string;
  messageId: string;
}

type Status = "idle" | "open" | "submitting" | "flagged";

export function ResponseFeedback({ conversationId, messageId }: ResponseFeedbackProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  // Minor #7 (final-review fix): useId(), matching commentId above, instead
  // of a module-level string constant -- harmless today since only one of
  // these dialogs can be open at a time, but a module-level `name` stops
  // being safe the moment that assumption changes, and useId() costs
  // nothing to use consistently now.
  const reasonGroupName = useId();
  // Important #2 (final-review fix): #298 closed this exact defect class
  // for ErrorBoundary's fallback and App.tsx's HomeworkLoadError -- a state
  // transition that unmounts BOTH a dialog and its trigger button in the
  // same commit leaves the native <dialog>'s focus restoration with
  // nowhere to land, so focus falls to <body>. That transition is exactly
  // what "open"/"submitting" -> "flagged" does here (the AlertDialog closes
  // and the trigger button is replaced by the flagged badge, together).
  // Mirrors HomeworkLoadError's own ref-plus-effect pattern: a `tabIndex={-1}`
  // element the confirmation itself, focused the instant the transition
  // happens.
  const flaggedRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (status === "flagged") {
      flaggedRef.current?.focus();
    }
  }, [status]);

  const closeDialog = () => {
    setStatus("idle");
    setReason(null);
    setComment("");
    setError(null);
  };

  const handleSubmit = async () => {
    if (!reason) {
      setError("Choose a reason before submitting.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages/${messageId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, comment: comment.trim() || undefined }),
      });
      if (res.ok) {
        setStatus("flagged");
        return;
      }
      // #90: a 409 already_flagged means an earlier session (or a fast
      // double-click) already recorded this exact flag -- the student's
      // intent ("this response is wrong") is already satisfied server-
      // side, so this is treated the same as a fresh success rather than
      // surfaced as an error asking them to fix something.
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (res.status === 409 && body?.code === "already_flagged") {
        setStatus("flagged");
        return;
      }
      setError(body?.error ?? "Something went wrong submitting this. Please try again.");
      setStatus("open");
    } catch {
      setError("Something went wrong submitting this. Check your connection and try again.");
      setStatus("open");
    }
  };

  if (status === "flagged") {
    return (
      <span
        ref={flaggedRef}
        tabIndex={-1}
        className="response-feedback response-feedback--flagged"
        title="You flagged this response"
      >
        <Flag size={13} weight="fill" aria-hidden="true" />
        <span className="sr-only">You flagged this response</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="message__action response-feedback__trigger"
        onClick={() => setStatus("open")}
        aria-label="Flag this response"
      >
        <Flag size={13} weight="regular" aria-hidden="true" />
      </button>
      {/* Mounted only once the student actually opens it, not unconditionally
         alongside every trigger button. AlertDialog renders a real native
         <dialog> plus an effect that runs on every render regardless of
         `open` -- a homework-section transcript can hold up to
         MAX_HISTORY_MESSAGES worth of assistant turns (200), and mounting
         one closed dialog per turn measurably slowed the transcript (found
         via App.test.tsx's own "section transcript load-older" suite timing
         out at full-suite scale once this component started rendering on
         every hydrated assistant message). Unmounting on close (rather than
         leaving it mounted with open=false) is what keeps this component's
         own two rendered states -- lightweight while idle, real dialog only
         while in use -- byte-for-byte, since `status` already fully resets
         in closeDialog. */}
      {status !== "idle" && (
        <AlertDialog
          open={status === "open" || status === "submitting"}
          title="Flag this response"
          confirmLabel="Submit"
          confirmVariant="accent"
          confirming={status === "submitting"}
          onCancel={closeDialog}
          onConfirm={() => void handleSubmit()}
          description={
            <div className="response-feedback__form">
              <p className="response-feedback__prompt">
                Let your instructor know what was wrong with this response. This isn&rsquo;t saved as part of your
                graded work.
              </p>
              <fieldset className="response-feedback__reasons">
                <legend>Reason</legend>
                {REASON_OPTIONS.map((opt) => (
                  <label key={opt.value} className="response-feedback__reason-option">
                    <input
                      type="radio"
                      name={reasonGroupName}
                      value={opt.value}
                      checked={reason === opt.value}
                      onChange={() => setReason(opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </fieldset>
              <label className="response-feedback__comment-label" htmlFor={commentId}>
                Comment (optional)
              </label>
              <textarea
                id={commentId}
                className="response-feedback__comment"
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_CHARS))}
                maxLength={MAX_COMMENT_CHARS}
                rows={3}
              />
              {error && (
                <p className="response-feedback__error" role="alert">
                  {error}
                </p>
              )}
            </div>
          }
        />
      )}
    </>
  );
}
