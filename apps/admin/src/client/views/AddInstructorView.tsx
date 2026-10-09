/* --------------------------------------------------------------------------
   AddInstructorView — grants courseless, platform-wide instructor access
   by email (#316).

   Super-admin-only: App.tsx gates the nav entry and this view on
   isSuperAdmin, never canAuthor (a course-scoped "admin" role must not
   reach this -- granting instructor access is a platform-wide privilege
   escalation, not course authorship). The backing endpoint,
   POST /api/platform/instructors, is requireSuperAdmin(), so this view is
   never reachable by anyone else.

   Deliberately no courseId field: the whole point of this grant is
   onboarding someone before any course exists for them
   (course_memberships.courseId is NOT NULL, so that table cannot represent
   a courseless instructor). The person still holds zero course authority
   until a super admin separately adds them to a real course (the "Add
   member" endpoint from the same issue) -- this view only recognizes them
   platform-wide, matching what grantPlatformInstructor actually grants.
   -------------------------------------------------------------------------- */

import { useRef, useState } from "react";
import { Warning, CheckCircle } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { abortAfter } from "../lib/abortAfter";
import { apiClient, ApiError } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";

/** Copy per outcome. `granted` covers both a brand-new pending user and an
 *  already-granted one re-confirmed -- grantPlatformInstructor is
 *  idempotent, so there is no separate "already granted" status to explain. */
const OUTCOME_COPY = {
  granted: "Granted. They'll have instructor access the moment they sign in with that email.",
} as const;

export function AddInstructorView() {
  const instructorsResource = useApiResource((opts) => apiClient.platformInstructors.list(opts), []);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: "granted"; grantedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  if (!abortRef.current) abortRef.current = new AbortController();

  const trimmed = email.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || trimmed === "") return;
    setBusy(true);
    setError(null);
    setResult(null);
    const { signal, dispose } = abortAfter(15_000, abortRef.current?.signal ?? null);
    try {
      const outcome = await apiClient.platformInstructors.grant(trimmed, { signal });
      if (outcome.status === "granted" && outcome.grantedAt) {
        setResult({ status: "granted", grantedAt: outcome.grantedAt });
        setEmail("");
        instructorsResource.reload();
      } else {
        // "invalid_email" / "disallowed_domain" -- the server's own sentence
        // (via ApiError below) already explains why, so this path is only
        // reached if the shape is otherwise unexpected.
        setError(outcome.message ?? "That email address could not be granted access.");
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      const message =
        err instanceof ApiError
          ? err.message
          : (err as Error)?.name === "TimeoutError"
            ? "Granting access timed out. Reload to check whether it went through."
            : "Could not grant access. Please try again.";
      setError(message);
    } finally {
      dispose();
      setBusy(false);
    }
  }

  return (
    <div className="admin-view">
      <PageHeader eyebrow="SUPER ADMIN" title="Add Instructor" />

      <section className="admin-accession" aria-labelledby="add-instructor-heading">
        <h2 className="admin-accession__eyebrow" id="add-instructor-heading">
          Grant instructor access
        </h2>
        <form onSubmit={submit}>
          <label className="admin-accession__label" htmlFor="add-instructor-email">
            Email address
          </label>
          <p className="admin-accession__hint" id="add-instructor-hint">
            Grants platform-wide instructor recognition -- not access to any specific
            course. They'll still need to be added to a course before they can do
            anything with it.
          </p>
          <input
            id="add-instructor-email"
            className="admin-accession__field"
            type="email"
            aria-describedby="add-instructor-hint"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="instructor@uw.edu"
          />
          <div className="admin-accession__actions">
            <button type="submit" className="admin-accession__submit" disabled={busy || trimmed === ""}>
              {busy ? "Granting…" : "Grant instructor access"}
            </button>
          </div>
        </form>

        {error && (
          <div className="admin-alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} weight="regular" />
            </span>
            <span>{error}</span>
          </div>
        )}

        {result && (
          // No dedicated success-alert class exists in this stylesheet
          // (only .admin-alert's warning styling) -- matches
          // CanvasIntegrationView's own convention for a positive
          // confirmation: a plain hint line with an inline check icon,
          // not a colored banner.
          <p className="admin-form-hint">
            <CheckCircle size={14} weight="fill" aria-hidden="true" className="mr-1" />
            {OUTCOME_COPY.granted}
          </p>
        )}
      </section>

      <section aria-labelledby="all-instructors-heading">
        <h2 id="all-instructors-heading">All instructors</h2>
        {instructorsResource.loading && !instructorsResource.data ? <ViewLoading label="Loading instructors…" /> : null}
        {instructorsResource.error ? <ViewError error={instructorsResource.error} onRetry={instructorsResource.reload} detail="GET /api/platform/instructors" /> : null}
        {instructorsResource.data?.instructors.length === 0 ? <ViewEmpty title="No instructors yet" body="Grant instructor access above or create a course shell." /> : null}
        {instructorsResource.data?.instructors.length ? <table className="admin-table">
          <caption className="admin-visually-hidden">Everyone with instructor portal access</caption>
          <thead><tr><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Access granted</th><th scope="col">Assigned courses</th></tr></thead>
          <tbody>{instructorsResource.data.instructors.map((instructor) => <tr key={instructor.userId}>
            <th scope="row">{instructor.email}</th>
            <td>{instructor.status === "signed_in" ? "Signed in" : "Pending"}</td>
            <td>{new Date(instructor.grantedAt).toLocaleDateString()}</td>
            <td>{instructor.assignedCourseCount}</td>
          </tr>)}</tbody>
        </table> : null}
      </section>
    </div>
  );
}
