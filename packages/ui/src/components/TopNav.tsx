/* --------------------------------------------------------------------------
   TopNav — full-bleed top navigation bar.

   Three zones (left → center → right):
     Wordmark: "LLteacher" + "· UNIVERSITY OF WASHINGTON" affiliation tag
     Breadcrumb: course · term · homework in Geist Mono small-caps
     User menu: circular initials chip with chevron

   Surface: UW Husky Purple #32006e, 56px tall.
   Bottom rule: #26005A (one step darker than bg) — quiet anchor line.

   Text/bg contrast pairs on Husky Purple:
     White (#FFFFFF): ~13:1 ✓ AAA
     #E8E3D3 (Husky Gold web): ~11:1 ✓ AAA
     #B7A57A (Husky Gold print): ~5.9:1 ✓ AA
   -------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";

export interface TopNavProps {
  /** Short course code, e.g. "STATS 311". OPTIONAL (#294): the student app
   *  has no data source for this yet, and a hardcoded literal here is worse
   *  than an absent segment -- it asserts a specific course to every student
   *  in every course. Omitted segments simply do not appear in the
   *  breadcrumb. */
  course?: string;
  /** Term string, e.g. "Autumn 2026". Optional for the same #294 reason. */
  term?: string;
  /** Trailing breadcrumb segment. Student app: homework name. Admin app:
      the current view label (e.g. "HOMEWORKS", "LLM CONFIGS"). */
  homework: string;
  /** Two-letter user initials for the avatar chip */
  /** Two-letter user initials for the avatar chip. OPTIONAL (#294): absent
   *  while the profile is loading, when signed out, or when the account has
   *  no display name. The chip then shows a neutral placeholder rather than
   *  fabricated letters -- the defect this fixes was a hardcoded "AC" shown
   *  to every student, initials belonging to no signed-in user. */
  userInitials?: string;
  /** Admin mode: swaps the affiliation tag's leading bullet for a
      Heritage Gold dot + "Admin" label. The dot is the at-a-glance
      "you are in the instructor console" cue across the bar. */
  admin?: boolean;
  /** Whether the current visitor has an active session. Governs whether
      the dropdown offers "Log in" or "Profile" + "Log out". */
  isAuthenticated?: boolean;
  /** Shown as "Log in" when `isAuthenticated` is false. */
  onLogin?: () => void;
  /** Shown as "Profile" when `isAuthenticated` is true. */
  onProfileClick?: () => void;
  /** Shown as "Log out" when `isAuthenticated` is true. */
  onLogout?: () => void;
}

export function TopNav({
  course,
  term,
  homework,
  userInitials,
  admin = false,
  isAuthenticated = false,
  onLogin,
  onProfileClick,
  onLogout,
}: TopNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const userGroupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => setMenuOpen(false);

  // Click-outside-to-close.
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (userGroupRef.current && !userGroupRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  // Escape-to-close, with focus returned to the trigger -- the disclosure
  // is a plain button + list of links (not a full ARIA menu widget, which
  // would also need arrow-key navigation this 2-item menu doesn't warrant).
  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeMenu();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  const selectItem = (handler?: () => void) => {
    closeMenu();
    handler?.();
  };

  /* #294: built from whichever segments the caller actually has. Course and
     term are omitted rather than defaulted, because the failure this fixes
     was a confidently-wrong label, not a missing one. */
  const breadcrumbText = [course, term, homework]
    .filter((segment): segment is string => typeof segment === "string" && segment.trim() !== "")
    .map((segment) => segment.toUpperCase())
    .join(" · ");

  return (
    <header className="top-nav" role="banner">
      {/* Left: wordmark + affiliation */}
      <div className="top-nav__wordmark-group">
        <span className="top-nav__wordmark">LLteacher</span>
        <span
          className={admin ? "top-nav__tag top-nav__tag--admin" : "top-nav__tag"}
          aria-label={admin ? "Admin, University of Washington" : "University of Washington"}
        >
          {admin ? (
            <>
              <span className="top-nav__admin-dot" aria-hidden="true" />
              Admin · University of Washington
            </>
          ) : (
            "· University of Washington"
          )}
        </span>
      </div>

      {/* Center: course breadcrumb */}
      <div className="top-nav__breadcrumb" aria-label="Current context">
        {breadcrumbText}
      </div>

      {/* Right: user menu chip -- a plain disclosure (button + list of
          links), not an ARIA menu widget: this 2-item menu doesn't warrant
          arrow-key navigation, but it does need Escape and click-outside
          to close, which the effects above provide. */}
      <div className="top-nav__user-group" ref={userGroupRef}>
        <button
          ref={triggerRef}
          className="top-nav__user-chip"
          type="button"
          aria-label="Account menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          {/* #294: a neutral dot, not invented letters. aria-hidden because
              the chip's own aria-label already names the control -- the
              placeholder is decoration, and reading it out would announce a
              character that means nothing. */}
          <span className="top-nav__user-initials" aria-hidden={!userInitials || undefined}>
            {userInitials || "\u00B7"}
          </span>
          <span
            className="top-nav__user-chevron"
            aria-hidden="true"
            style={{ transform: menuOpen ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            <CaretRight size={14} weight="regular" />
          </span>
        </button>
        {menuOpen && (onLogin || onProfileClick || onLogout) && (
          <div className="top-nav__user-menu">
            {!isAuthenticated && onLogin && (
              <button
                className="top-nav__user-menu-item"
                type="button"
                onClick={() => selectItem(onLogin)}
              >
                Log in
              </button>
            )}
            {isAuthenticated && onProfileClick && (
              <button
                className="top-nav__user-menu-item"
                type="button"
                onClick={() => selectItem(onProfileClick)}
              >
                Profile
              </button>
            )}
            {isAuthenticated && onLogout && (
              <button
                className="top-nav__user-menu-item"
                type="button"
                onClick={() => selectItem(onLogout)}
              >
                Log out
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
