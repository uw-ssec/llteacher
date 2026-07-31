import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import App from "./App";
import { ProfileView } from "./components/ProfileView";
import { AuthProvider } from "./components/AuthProvider";
import "@llteacher/ui/styles.css";

const router = createBrowserRouter([
  { path: "/", element: <App /> },
  { path: "/profile", element: <ProfileView /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
