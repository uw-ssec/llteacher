/* --------------------------------------------------------------------------
   UnauthenticatedAdmin — shown to a signed-out visitor of the admin console.
   Parity with apps/web's UnauthenticatedHome: minimal wordmark + login
   button, not a full branded landing page (issue #55 owns that design pass).
   -------------------------------------------------------------------------- */

export interface UnauthenticatedAdminProps {
  onLogin: () => void;
  /** True when the session check itself failed (backend/DB unavailable). */
  error?: boolean;
}

export function UnauthenticatedAdmin({ onLogin, error = false }: UnauthenticatedAdminProps) {
  return (
    <div className="unauthenticated-home">
      <h1>LLteacher · Instructor Console</h1>
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
