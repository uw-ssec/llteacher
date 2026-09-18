/* --------------------------------------------------------------------------
   Deriving a folder tree from OKF paths (#42).

   There is no directory table: OKF has no directory entity, and paths ARE
   identity. So the tree is a projection of the path list, computed here
   rather than in two views that would drift.

   index and log documents are structure, not content -- they are what makes
   an empty folder exist and what carries the change history -- so a
   directory listing shows concepts only.
   -------------------------------------------------------------------------- */

export interface TreeDocument {
  id: string;
  path: string;
  kind: "concept" | "index" | "log";
}

export function directoryOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/** Every directory in the bundle, root ("") first, then depth-first by name.
 *  Derived from every document regardless of kind, so a folder created but
 *  not yet filled with a concept (only an index document) still appears. */
export function directoriesOf(documents: readonly TreeDocument[]): string[] {
  const directories = new Set<string>([""]);
  for (const document of documents) {
    const segments = document.path.split("/").slice(0, -1);
    for (let i = 0; i < segments.length; i++) {
      directories.add(segments.slice(0, i + 1).join("/"));
    }
  }
  return [...directories].sort();
}

/** The concepts directly inside one directory — not its subdirectories'.
 *  Generic over the caller's own document shape (as long as it satisfies
 *  `TreeDocument`) so a caller passing the richer wire payload gets its own
 *  fields back rather than being narrowed down to just id/path/kind. */
export function documentsIn<T extends TreeDocument>(
  documents: readonly T[],
  directory: string,
): T[] {
  return documents
    .filter((d) => d.kind === "concept" && directoryOf(d.path) === directory)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function depthOf(directory: string): number {
  return directory === "" ? 0 : directory.split("/").length;
}

export function nameOf(directory: string): string {
  return directory === "" ? "Knowledge base" : (directory.split("/").pop() ?? directory);
}

/* -- Nested tree (search-first redesign) -------------------------------------
   The rail needs collapsible folders with counts, which the flat, sorted
   `directoriesOf` list cannot express. Same projection rule: every
   directory named by any document's path exists, even if only an index
   document created it. */

export interface TreeNode {
  name: string;
  path: string;
  /** Concepts inside, recursively. index and log documents are structure. */
  count: number;
  /** Documents of any kind inside, recursively, whose indexStatus is not
   *  "indexed" -- what the rail marks so an instructor can find them. */
  attention: number;
  children: TreeNode[];
}

export function treeOf(
  documents: readonly (TreeDocument & { indexStatus?: string })[],
): TreeNode {
  const root: TreeNode = { name: "Knowledge base", path: "", count: 0, attention: 0, children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const nodeFor = (dir: string): TreeNode => {
    const found = byPath.get(dir);
    if (found) return found;
    const parent = nodeFor(directoryOf(dir));
    const node: TreeNode = { name: dir.split("/").pop() ?? dir, path: dir, count: 0, attention: 0, children: [] };
    parent.children.push(node);
    byPath.set(dir, node);
    return node;
  };
  for (const document of documents) {
    const leaf = nodeFor(directoryOf(document.path));
    const isConcept = document.kind === "concept";
    const needsAttention = document.indexStatus !== undefined && document.indexStatus !== "indexed";
    for (const dir of ancestorsOf(leaf.path)) {
      const node = byPath.get(dir)!;
      if (isConcept) node.count += 1;
      if (needsAttention) node.attention += 1;
    }
  }
  const sortChildren = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}

/** Root first, then each folder down to `path` itself. */
export function ancestorsOf(path: string): string[] {
  if (path === "") return [""];
  const segments = path.split("/");
  return ["", ...segments.map((_, i) => segments.slice(0, i + 1).join("/"))];
}
