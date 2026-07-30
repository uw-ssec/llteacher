/* --------------------------------------------------------------------------
   PageHeader — the title strip at the top of every admin view.

   Top row: small Heritage Gold mono eyebrow (e.g., "HOMEWORKS · 5
   RECORDS"). Below: large Geist Sans title + optional secondary action
   strip. The eyebrow + title pair is the consistent "you are here"
   anchor across every admin view.
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";

export type PageHeaderProps = {
  /** Accepts a string or a ReactNode so the eyebrow can embed a RecordId */
  eyebrow: ReactNode;
  title: string;
  /** Optional supporting line beneath the title */
  subtitle?: string;
  /** Actions rendered on the right of the title row (typically a button) */
  actions?: ReactNode;
};

export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="admin-page-header">
      <div className="admin-page-header__eyebrow">{eyebrow}</div>
      <div className="admin-page-header__title-row">
        <h1 className="admin-page-header__title">{title}</h1>
        {actions && <div className="admin-page-header__actions">{actions}</div>}
      </div>
      {subtitle && <p className="admin-page-header__subtitle">{subtitle}</p>}
    </header>
  );
}
