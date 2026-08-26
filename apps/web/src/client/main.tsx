import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useRouteError } from "react-router";
import App from "./App";
import { ProfileView } from "./components/ProfileView";
import { AuthProvider } from "./components/AuthProvider";
import "@llteacher/ui/styles.css";

/* #144: route-level errorElement -- defense-in-depth alongside the
   component ErrorBoundary App.tsx wraps around each chat surface. That
   component boundary is deliberately scoped to just the chat column (see
   its own doc comment), so a throw in a sibling -- Sidebar, TopNav,
   TutorConversationsList, or App itself before it gets to render the chat
   column at all -- would still propagate up here instead. Without this
   (the pre-#144 state), any of those would white-screen the whole app with
   no recovery affordance, same as the chat-column throws #144 was actually
   filed about. */
function RouteErrorBoundary() {
  const error = useRouteError();
  console.error("[RouteErrorBoundary] caught a route render error", error);
  // #298: this component only ever mounts as a route's errorElement -- so
  // mounting itself IS "the error just appeared," unlike ErrorBoundary
  // (which stays mounted and toggles between children/fallback). Focusing
  // on mount is the equivalent restore-focus treatment for a component
  // that has no prior state to compare against.
  const fallbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fallbackRef.current?.focus();
  }, []);
  return (
    <div className="page-frame">
      <div className="app-shell">
        <div className="error-boundary-fallback" role="alert" tabIndex={-1} ref={fallbackRef}>
          {/* h1 because this replaces the entire route -- a page whose whole
              purpose is to explain a failure previously had no heading at all,
              so a screen-reader user pressing H found nothing. */}
          <h1 className="error-boundary-fallback__label">Page stopped</h1>
          <p className="error-boundary-fallback__body">
            This page couldn&apos;t be displayed. Anything you already submitted is saved.
            Reloading usually fixes it.
          </p>
          {/* Reload first, because that is what the copy prescribes and what
              actually re-runs the failed render. "Go home" navigates away from
              the thing the reader was trying to reach. */}
          <button
            type="button"
            className="error-boundary-fallback__retry"
            onClick={() => window.location.reload()}
          >
            Reload this page
            <span aria-hidden="true">→</span>
          </button>
          <a className="error-boundary-fallback__secondary" href="/">
            Back to your homework
          </a>
        </div>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/", element: <App />, errorElement: <RouteErrorBoundary /> },
  { path: "/profile", element: <ProfileView />, errorElement: <RouteErrorBoundary /> },
  { path: "*", element: <NotFound /> },
]);

function NotFound() {
  return (
    <div className="not-found">
      <h1>That page isn&apos;t here</h1>
      <p>
        The link may be out of date, or the homework may have been withdrawn by your
        instructor.
      </p>
      <a href="/">
        Back to your homework
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
