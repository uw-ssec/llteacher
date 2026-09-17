import type { ReactNode } from "react";
import { TopNav } from "@llteacher/ui";
import { useAuth, initialsFrom } from "./AuthProvider";
import "./account.css";

export function AccountShell({ title, children }: { title: string; children: ReactNode }) {
  const { displayName, logout } = useAuth();
  return (
    <div className="page-frame account-page">
      <TopNav homework={title} isAuthenticated userInitials={initialsFrom(displayName) ?? undefined}
        onProfileClick={() => window.location.assign("/profile")} onLogout={logout} />
      <main className="account-content">
        <a href="/">Home</a>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function StaffHome() {
  const configuredUrl = import.meta.env.VITE_ADMIN_URL as string | undefined;
  // The two local development pairs; deployments set their console URL explicitly.
  const localPorts: Record<string, string> = { "2311": "2312", "2411": "2412" };
  const url = new URL(window.location.origin);
  const localPort = ["localhost", "127.0.0.1"].includes(url.hostname) ? localPorts[url.port] : undefined;
  if (localPort) url.port = localPort;
  const consoleUrl = configuredUrl || (localPort ? url.origin : undefined);
  return (
    <section>
      <h2>Your teaching workspace</h2>
      <p>Your account has course staff access. Manage homework and course materials in the instructor console.</p>
      {consoleUrl ? <a className="account-action" href={consoleUrl}>Open instructor console →</a>
        : <p>Use your institution’s instructor console link to open your teaching workspace.</p>}
      <p>Student homework appears here when you are enrolled as a student in a course.</p>
    </section>
  );
}
