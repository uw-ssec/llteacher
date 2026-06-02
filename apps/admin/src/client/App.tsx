/* --------------------------------------------------------------------------
   LLteacher Admin — minimal scaffold.

   This is the instructor-facing surface. It will eventually own:
     · Course / homework / section authoring
     · Student roster and submission review
     · Conversation grading
     · LLM configuration

   Today it renders the UW chrome (top nav + sidebar) with a placeholder
   main column so the design language is locked in from day 1 of admin work.
   -------------------------------------------------------------------------- */

import { Books, Notebook, Tray, Sparkle, CaretRight } from "@phosphor-icons/react";

export default function App() {
  return (
    <div className="app-shell-vertical">
      {/* Top nav — UW Husky Purple chrome, mirrors the student web/ app */}
      <header className="top-nav">
        <div className="top-nav__left">
          <span className="top-nav__wordmark">LLteacher</span>
          <span className="top-nav__tag">
            <span className="top-nav__tag-sep" aria-hidden="true">·</span>
            ADMIN · UNIVERSITY OF WASHINGTON
          </span>
        </div>
        <div className="top-nav__center">
          <span className="top-nav__breadcrumb">STATS 311 · AUTUMN 2026 · INSTRUCTOR CONSOLE</span>
        </div>
        <div className="top-nav__right">
          <button type="button" className="top-nav__user-chip" aria-label="Account menu">
            <span className="top-nav__user-initials">IC</span>
            <span className="top-nav__user-chevron" aria-hidden="true">
              <CaretRight size={14} weight="regular" />
            </span>
          </button>
        </div>
      </header>

      <div className="app-shell">
        {/* Sidebar — placeholder rail using the same UW Husky Purple chrome */}
        <aside className="sidebar">
          <div className="sidebar__hw-label">CONSOLE · COMING SOON</div>
          <ol className="sidebar__section-list">
            <li className="section-item section-item--pending">
              <span className="section-item__indicator section-item__indicator--pending" aria-hidden="true">
                <Books size={14} weight="regular" />
              </span>
              <span className="section-item__number">1</span>
              <span className="section-item__title">Courses</span>
            </li>
            <li className="section-item section-item--pending">
              <span className="section-item__indicator section-item__indicator--pending" aria-hidden="true">
                <Notebook size={14} weight="regular" />
              </span>
              <span className="section-item__number">2</span>
              <span className="section-item__title">Homeworks</span>
            </li>
            <li className="section-item section-item--pending">
              <span className="section-item__indicator section-item__indicator--pending" aria-hidden="true">
                <Tray size={14} weight="regular" />
              </span>
              <span className="section-item__number">3</span>
              <span className="section-item__title">Submissions</span>
            </li>
            <li className="section-item section-item--pending">
              <span className="section-item__indicator section-item__indicator--pending" aria-hidden="true">
                <Sparkle size={14} weight="regular" />
              </span>
              <span className="section-item__number">4</span>
              <span className="section-item__title">LLM configs</span>
            </li>
          </ol>
          <div className="sidebar__spacer" />
          <div className="sidebar__worker">monorepo: admin · port 2312</div>
        </aside>

        {/* Main column — placeholder */}
        <main className="conversation-column">
          <div className="conversation-messages">
            <div className="conversation-inner">
              <div className="breadcrumb">ADMIN · CONSOLE · PLACEHOLDER</div>
              <div className="message message--ai">
                <div className="message__ai-body">
                  <p>
                    This is the instructor admin surface. The student-facing
                    chat product lives at the <code>web</code> workspace on
                    port 2311; this admin app lives here on port 2312.
                  </p>
                  <p>
                    The design tokens, top nav, and sidebar chrome are
                    intentionally shared so both surfaces feel like one
                    product. Course authoring, submission grading, and LLM
                    configuration will live here.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
