import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AuthSessionState {
  isAuthenticated: boolean;
  loading: boolean;
  /** True when the session check itself failed (backend/DB unavailable) --
   *  distinct from `isAuthenticated: false`, which means "no session." */
  error: boolean;
  login: () => void;
  logout: () => void;
}

export interface AuthProviderOptions<TExtra extends object> {
  /** Reads app-specific fields (e.g. admin's `role`) off a successful
   *  GET /api/profile response body. Omit for apps that only need session
   *  state. */
  parseExtra?: (body: unknown) => TExtra;
  /** Value for the extra fields while signed out, on error, or before the
   *  first response arrives. */
  defaultExtra: TExtra;
}

/** Builds a typed `{ AuthProvider, useAuth }` pair. apps/web and
 *  apps/admin need the identical session-fetch-on-mount effect (with its
 *  cancelled-flag cleanup) and the hidden-form logout() workaround -- see
 *  logout() below for why a real form submission is required. The only
 *  real divergence between the two apps is admin's extra `role` field,
 *  expressed here via `parseExtra`/`defaultExtra` rather than a forked
 *  copy of the whole provider. */
export function createAuthProvider<TExtra extends object = Record<string, never>>(
  options?: AuthProviderOptions<TExtra>,
) {
  const parseExtra = options?.parseExtra;
  const defaultExtra = (options?.defaultExtra ?? {}) as TExtra;

  type State = AuthSessionState & TExtra;
  const Context = createContext<State | null>(null);

  function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [extra, setExtra] = useState<TExtra>(defaultExtra);

    useEffect(() => {
      let cancelled = false;
      fetch("/api/profile")
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 401) {
            setIsAuthenticated(false);
            setExtra(defaultExtra);
            setError(false);
          } else if (res.ok) {
            const body: unknown = await res.json();
            setIsAuthenticated(true);
            setExtra(parseExtra ? parseExtra(body) : defaultExtra);
            setError(false);
          } else {
            // Any other status (5xx, etc.) means the backend couldn't tell
            // us whether the session is valid -- surface that, don't
            // silently treat it as "logged out."
            setIsAuthenticated(false);
            setExtra(defaultExtra);
            setError(true);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setIsAuthenticated(false);
            setExtra(defaultExtra);
            setError(true);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const login = useCallback(() => {
      window.location.href = "/api/auth/login";
    }, []);

    // The logout route is POST-only and issues a redirect to WorkOS's own
    // logout URL. A fetch()-based POST follows that redirect as a
    // background request -- the browser's top-level location never
    // navigates, so the WorkOS session cookie is never cleared and
    // `returnTo` never fires. Submitting a real (hidden) form makes this a
    // top-level navigation, so the browser follows the 302 natively and
    // actually lands on WorkOS's logout flow / returnTo target.
    const logout = useCallback(() => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/api/auth/logout";
      document.body.appendChild(form);
      form.submit();
    }, []);

    const value = useMemo(
      () => ({ isAuthenticated, loading, error, ...extra, login, logout }) as State,
      [isAuthenticated, loading, error, extra, login, logout],
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  function useAuth(): State {
    const ctx = useContext(Context);
    if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
    return ctx;
  }

  return { AuthProvider, useAuth };
}
