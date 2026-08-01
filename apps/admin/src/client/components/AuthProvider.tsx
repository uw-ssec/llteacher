import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Mirrors apps/web's role union without importing across the app boundary
 *  (admin has no access to apps/web's server-side types). Kept as a plain
 *  string union here; both sides ultimately derive from the same
 *  course_role Postgres enum (apps/web/src/db/schema/identity.ts). */
export type CourseRole = "instructor" | "ta" | "student" | "observer" | "admin";

interface AuthState {
  isAuthenticated: boolean;
  loading: boolean;
  /** True when the session check itself failed (backend/DB unavailable) --
   *  distinct from `isAuthenticated: false`, which means "no session." */
  error: boolean;
  role: CourseRole | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [role, setRole] = useState<CourseRole | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setIsAuthenticated(false);
          setRole(null);
          setError(false);
        } else if (res.ok) {
          const body = (await res.json()) as { role?: CourseRole | null };
          setIsAuthenticated(true);
          setRole(body.role ?? null);
          setError(false);
        } else {
          setIsAuthenticated(false);
          setRole(null);
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsAuthenticated(false);
          setRole(null);
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
    <AuthContext.Provider value={{ isAuthenticated, loading, error, role, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
