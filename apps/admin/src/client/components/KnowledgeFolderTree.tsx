/* --------------------------------------------------------------------------
   KnowledgeFolderTree — the collapsible folder rail of the knowledge base.

   A real tree rather than the flat indented list it replaces: every folder
   collapses, carries its recursive concept count, and marks when something
   inside is not indexed. Expansion is owned by the caller so it can survive
   a drill-in and back the same way the selected folder already does.

   The chevron is its own button, not a span inside the name button: a
   button inside a button is invalid HTML and reads as one control to a
   screen reader, which would make "expand" and "select" indistinguishable.
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
      <ul className="admin-knowledge__tree" role="tree">
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
    <li role="none" className="admin-knowledge__tree-item">
      <div className={isSelected ? "admin-knowledge__node admin-knowledge__node--selected" : "admin-knowledge__node"}>
        {hasChildren ? (
          <button
            type="button"
            className={isOpen ? "admin-knowledge__chevron admin-knowledge__chevron--open" : "admin-knowledge__chevron"}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
            onClick={() => onToggle(node.path)}
          >
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          </button>
        ) : (
          <span className="admin-knowledge__chevron admin-knowledge__chevron--leaf" aria-hidden="true" />
        )}
        <button
          type="button"
          role="treeitem"
          aria-selected={isSelected}
          aria-expanded={hasChildren ? isOpen : undefined}
          className="admin-knowledge__folder"
          onClick={() => onSelect(node.path)}
        >
          <span className="admin-knowledge__folder-name">{node.name}</span>
          <span
            className={node.attention > 0 ? "admin-knowledge__count admin-knowledge__count--attention" : "admin-knowledge__count"}
            title={node.attention > 0 ? `${node.attention} need${node.attention === 1 ? "s" : ""} attention` : undefined}
          >
            {node.count}
          </span>
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul role="group" className="admin-knowledge__tree-children">
          {node.children.map((child) => (
            <Node key={child.path} node={child} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}
