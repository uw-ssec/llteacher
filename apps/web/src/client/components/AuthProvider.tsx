import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface AuthState {
  isAuthenticated: boolean;
  loading: boolean;
  /** True when the session check itself failed (backend/DB unavailable) --
   *  distinct from `isAuthenticated: false`, which means "no session." */
  error: boolean;
  login: () => void;
  logout: () => Promise<void>;
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

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setIsAuthenticated(false);
    window.location.href = "/";
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
