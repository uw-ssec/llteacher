/* --------------------------------------------------------------------------
   ActionMenu — the console's overflow menu.

   Progressive disclosure for a header that had too many equal buttons: the
   one or two actions with state stay visible, the rest sit one click away
   behind a "More" button. Items keep their labels; the icon leads, the
   label carries certainty.

   Follows the menu-button pattern: aria-haspopup/aria-expanded on the
   trigger, role="menu" with menuitems, focus lands on the first item when
   the menu opens, arrows move between items, Escape closes and returns
   focus to the trigger, and a click outside closes. A "link" item renders
   a real anchor so a download is the browser's own, not a script's.
   -------------------------------------------------------------------------- */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DotsThree } from "@phosphor-icons/react";

export type ActionMenuItem =
  | { kind: "action"; label: string; icon?: ReactNode; hint?: string; onSelect: () => void; disabled?: boolean }
  | { kind: "link"; label: string; icon?: ReactNode; hint?: string; href: string; download?: string }
  | { kind: "group"; label: string };

export type ActionMenuProps = {
  label: string;
  items: ActionMenuItem[];
};

export function ActionMenu({ label, items }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])");
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const nodes = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nodes[(at + 1) % nodes.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); nodes[(at - 1 + nodes.length) % nodes.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); nodes[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (e.key === "Tab") close(false);
  }

  return (
    <div className="admin-menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="admin-button admin-button--ghost admin-menu__trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <DotsThree size={20} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} ref={menu} role="menu" aria-label={label} className="admin-menu__list" onKeyDown={onMenuKeyDown}>
          {items.map((item, i) =>
            item.kind === "group" ? (
              <div key={`g${i}`} className="admin-menu__group" role="presentation">{item.label}</div>
            ) : item.kind === "link" ? (
              <a
                key={`l${i}`}
                role="menuitem"
                className="admin-menu__item"
                href={item.href}
                download={item.download}
                onClick={() => close(false)}
              >
                {item.icon && <span className="admin-menu__icon" aria-hidden="true">{item.icon}</span>}
                <span>{item.label}</span>
                {item.hint && <span className="admin-menu__hint">{item.hint}</span>}
              </a>
            ) : (
              <button
                key={`a${i}`}
                type="button"
                role="menuitem"
                className="admin-menu__item"
                disabled={item.disabled}
                onClick={() => { close(true); item.onSelect(); }}
              >
                {item.icon && <span className="admin-menu__icon" aria-hidden="true">{item.icon}</span>}
                <span>{item.label}</span>
                {item.hint && <span className="admin-menu__hint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
