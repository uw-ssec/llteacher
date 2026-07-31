/* --------------------------------------------------------------------------
   UnauthenticatedHome — minimal placeholder shown to anonymous visitors.

   Deliberately not the branded landing page: issue #55 (M10: UW Branding
   & Accessibility) owns that design pass and explicitly asks M1 to
   "consume these components rather than improvising." This is the
   simplest thing that isn't the fixture course/chat demo -- wordmark +
   a login button, nothing else.
   -------------------------------------------------------------------------- */

export interface UnauthenticatedHomeProps {
  onLogin: () => void;
  /** True when the session check itself failed (backend/DB unavailable),
   *  not merely "no session" -- shown alongside the login button since
   *  the failure may be transient. */
  error?: boolean;
}

export function UnauthenticatedHome({ onLogin, error = false }: UnauthenticatedHomeProps) {
  return (
    <div className="unauthenticated-home">
      <h1>LLteacher</h1>
      {error && (
        <p role="alert" className="auth-error-banner">
          Login failed. Please try again later.
        </p>
      )}
      <button type="button" onClick={onLogin}>
        Log in
      </button>
    </div>
  );
}
