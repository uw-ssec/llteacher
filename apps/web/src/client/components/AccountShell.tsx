/* --------------------------------------------------------------------------
   AccountShell + StaffHome — the account pages of the student app.

   These are the only screens in apps/web that are not the tutor chat: the
   teaching workspace shown to course staff who hold no student membership,
   and the profile page. Both sit on the same paper ground and Husky Purple
   chrome as the chat, with Geist Mono eyebrows and a Heritage Gold hairline
   as the one recurring accent -- the shell extends the existing system
   rather than inventing a second one.

   The page owns its own heading. The shell provides the nav, the ground and
   the measure; nothing else, so the heading hierarchy is not repeated three
   times (nav breadcrumb, "Home" link, page title, card title) as it was.
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";
import { TopNav } from "@llteacher/ui";
import type { CourseMembershipSummary } from "../../shared/types";
import { useAuth, initialsFrom } from "./AuthProvider";
import "./account.css";

export function AccountShell({ title, children }: { title: string; children: ReactNode }) {
  const { displayName, logout } = useAuth();
  return (
    <div className="page-frame account-page">
      <TopNav homework={title} isAuthenticated userInitials={initialsFrom(displayName) ?? undefined}
        onProfileClick={() => window.location.assign("/profile")} onLogout={logout} />
      <main className="account-content">{children}</main>
    </div>
  );
}

/** Mono small-caps label with the Heritage Gold dot that marks staff
 *  context across the product (the admin nav uses the same dot). */
export function Eyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="account-eyebrow" id={id}>
      <span className="account-eyebrow__dot" aria-hidden="true" />
      {children}
    </p>
  );
}

const ROLE_LABEL: Record<CourseMembershipSummary["role"], string> = { instructor: "Instructor", ta: "TA", admin: "Admin", student: "Student", observer: "Observer" };

export function instructorConsoleUrl(): string | undefined {
  const configuredUrl = import.meta.env.VITE_ADMIN_URL as string | undefined;
  // The two local development pairs; deployments set their console URL explicitly.
  const localPorts: Record<string, string> = { "2311": "2312", "2411": "2412" };
  const url = new URL(window.location.origin);
  const localPort = ["localhost", "127.0.0.1"].includes(url.hostname) ? localPorts[url.port] : undefined;
  if (localPort) url.port = localPort;
  return configuredUrl || (localPort ? url.origin : undefined);
}

export function StaffHome() {
  const { staffCourses } = useAuth();
  const consoleUrl = instructorConsoleUrl();
  const count = staffCourses.length;
  return (
    <div className="staff-home">
      <header className="staff-home__lead">
        <Eyebrow>Course staff</Eyebrow>
        <h1 className="account-title">Your teaching workspace</h1>
        <p className="account-lede">
          Homework, course materials and the tutor’s knowledge base are managed in the instructor console.
        </p>
        {consoleUrl ? (
          <a className="account-cta" href={consoleUrl}>
            Open the instructor console
            <svg className="account-cta__arrow" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M3 10h13M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        ) : (
          <p className="account-note">Use your institution’s instructor console link to open your teaching workspace.</p>
        )}
      </header>

      <section className="staff-home__ledger" aria-labelledby="staff-courses">
        <Eyebrow id="staff-courses">Teaching · {count} {count === 1 ? "course" : "courses"}</Eyebrow>
        {count > 0 ? (
          <ol className="course-ledger">
            {staffCourses.map((course, i) => (
              <li key={course.id} className="course-ledger__row">
                <span className="course-ledger__index">{String(i + 1).padStart(2, "0")}</span>
                <span className="course-ledger__title">{course.title}</span>
                <span className="course-ledger__role">{ROLE_LABEL[course.role]}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="account-note course-ledger__empty">No course memberships yet. An instructor can add you from the console.</p>
        )}
        <p className="account-note">Student homework appears here only for courses where you are enrolled as a student.</p>
      </section>
    </div>
  );
}
