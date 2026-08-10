import { StrictMode } from "react";
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
  // eslint-disable-next-line no-console
  console.error("[RouteErrorBoundary] caught a route render error", error);
  return (
    <div className="page-frame">
      <div className="app-shell">
        <div className="error-boundary-fallback" role="alert">
          <p>Something went wrong. Please refresh the page.</p>
          <a href="/">Go home</a>
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
      <h1>Page not found</h1>
      <a href="/">Go home</a>
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
