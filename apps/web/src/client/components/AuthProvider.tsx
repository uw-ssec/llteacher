import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface AuthState {
  isAuthenticated: boolean;
  loading: boolean;
  /** True when the session check itself failed (backend/DB unavailable) --
   *  distinct from `isAuthenticated: false`, which means "no session." */
  error: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setIsAuthenticated(false);
          setError(false);
        } else if (res.ok) {
          setIsAuthenticated(true);
          setError(false);
        } else {
          // Any other status (5xx, etc.) means the backend couldn't tell us
          // whether the session is valid -- surface that, don't silently
          // treat it as "logged out."
          setIsAuthenticated(false);
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsAuthenticated(false);
          setError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = () => {
    window.location.href = "/api/auth/login";
  };

  // The logout route is POST-only and issues a redirect to WorkOS's own
  // logout URL. A fetch()-based POST follows that redirect as a background
  // request -- the browser's top-level location never navigates, so the
  // WorkOS session cookie is never cleared and `returnTo` never fires.
  // Submitting a real (hidden) form makes this a top-level navigation, so
  // the browser follows the 302 natively and actually lands on WorkOS's
  // logout flow / returnTo target.
  const logout = () => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/auth/logout";
    document.body.appendChild(form);
    form.submit();
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, loading, error, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
