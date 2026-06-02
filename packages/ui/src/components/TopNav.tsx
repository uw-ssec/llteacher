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

import { useState } from "react";
import { CaretRight } from "@phosphor-icons/react";

export interface TopNavProps {
  /** Short course code, e.g. "STATS 311" */
  course: string;
  /** Term string, e.g. "Autumn 2026" */
  term: string;
  /** Homework label, e.g. "HW 3 · Probability and Distributions" */
  homework: string;
  /** Two-letter user initials for the avatar chip */
  userInitials: string;
}

export function TopNav({ course, term, homework, userInitials }: TopNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const breadcrumbText = `${course.toUpperCase()} · ${term.toUpperCase()} · ${homework.toUpperCase()}`;

  return (
    <header className="top-nav" role="banner">
      {/* Left: wordmark + affiliation */}
      <div className="top-nav__wordmark-group">
        <span className="top-nav__wordmark">LLteacher</span>
        <span className="top-nav__tag" aria-label="University of Washington">
          · University of Washington
        </span>
      </div>

      {/* Center: course breadcrumb */}
      <div className="top-nav__breadcrumb" aria-label="Current context">
        {breadcrumbText}
      </div>

      {/* Right: user menu chip */}
      <div className="top-nav__user-group">
        <button
          className="top-nav__user-chip"
          type="button"
          aria-label="Account menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <span className="top-nav__user-initials">{userInitials}</span>
          <span
            className="top-nav__user-chevron"
            aria-hidden="true"
            style={{ transform: menuOpen ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            <CaretRight size={14} weight="regular" />
          </span>
        </button>
      </div>
    </header>
  );
}
