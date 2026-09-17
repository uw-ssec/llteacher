/* --------------------------------------------------------------------------
   KnowledgeFolderTree — the collapsible folder rail of the knowledge base.

   A real tree rather than the flat indented list it replaces: every folder
   collapses, carries its recursive concept count, and marks when something
   inside is not indexed. Expansion is owned by the caller so it can survive
   a drill-in and back the same way the selected folder already does.

   Follows the ARIA tree pattern for expansion: the chevron is a mouse
   affordance hidden from assistive tech, and the keyboard expands and
   collapses with the right and left arrows on the folder itself. That keeps
   one accessible control per folder, whose name is the folder's, so the
   console's tests (and a screen reader's element list) find "week1" once.
   -------------------------------------------------------------------------- */

import { CaretRight } from "@phosphor-icons/react";
import type { TreeNode } from "../lib/documentTree";

export type KnowledgeFolderTreeProps = {
  root: TreeNode;
  selected: string;
  expanded: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onCollapseAll: () => void;
};

export function KnowledgeFolderTree({ root, selected, expanded, onSelect, onToggle, onCollapseAll }: KnowledgeFolderTreeProps) {
  return (
    <nav className="admin-knowledge__rail" aria-label="Folders">
      <div className="admin-knowledge__rail-head">
        <h2 className="admin-knowledge__label">Folders</h2>
        <button type="button" className="admin-button admin-button--minimal" onClick={onCollapseAll}>
          Collapse all
        </button>
      </div>
      <ul className="admin-knowledge__tree">
        <Node node={root} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />
      </ul>
    </nav>
  );
}

function Node({
  node, selected, expanded, onSelect, onToggle,
}: { node: TreeNode } & Omit<KnowledgeFolderTreeProps, "root" | "onCollapseAll">) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  return (
    <li className="admin-knowledge__tree-item">
      <div className={isSelected ? "admin-knowledge__node admin-knowledge__node--selected" : "admin-knowledge__node"}>
        {hasChildren ? (
          <span
            className={isOpen ? "admin-knowledge__chevron admin-knowledge__chevron--open" : "admin-knowledge__chevron"}
            aria-hidden="true"
            data-toggle={node.path}
            onClick={() => onToggle(node.path)}
          >
            <CaretRight size={12} weight="bold" />
          </span>
        ) : (
          <span className="admin-knowledge__chevron admin-knowledge__chevron--leaf" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-current={isSelected ? "true" : undefined}
          aria-expanded={hasChildren ? isOpen : undefined}
          className="admin-knowledge__folder"
          onClick={() => onSelect(node.path)}
          onKeyDown={(e) => {
            if (!hasChildren) return;
            if (e.key === "ArrowRight" && !isOpen) { e.preventDefault(); onToggle(node.path); }
            if (e.key === "ArrowLeft" && isOpen) { e.preventDefault(); onToggle(node.path); }
          }}
        >
          <span className="admin-knowledge__folder-name">{node.name}</span>
          {" "}
          <span
            className={node.attention > 0 ? "admin-knowledge__count admin-knowledge__count--attention" : "admin-knowledge__count"}
            title={node.attention > 0 ? `${node.attention} need${node.attention === 1 ? "s" : ""} attention` : undefined}
          >
            {node.count}
          </span>
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul className="admin-knowledge__tree-children">
          {node.children.map((child) => (
            <Node key={child.path} node={child} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}
