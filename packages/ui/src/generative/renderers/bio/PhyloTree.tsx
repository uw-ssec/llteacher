/* --------------------------------------------------------------------------
   PhyloTree (`showPhyloTree`) -- a rectangular phylogram from Newick.

   Leaves evenly spaced, branches drawn as elbows. When every branch carries
   a length the x axis is evolutionary distance and a scale bar says so;
   when lengths are missing the tree is drawn as a cladogram (topology only)
   and the figure says THAT, so a student never reads branch length into a
   drawing that has none.
   -------------------------------------------------------------------------- */

import { leaves, parseNewick, type TreeNode } from "../../lib/bio";
import { FigurePlate } from "../../figure/FigurePlate";

export interface PhyloTreeProps {
  newick: string;
  title?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const ROW = 26;
const PAD_TOP = 14;
const PX0 = 12;
const LABEL_ROOM = 150;

interface Placed {
  node: TreeNode;
  x: number;
  y: number;
  children: Placed[];
}

function allHaveLengths(node: TreeNode, isRoot: boolean): boolean {
  if (!isRoot && node.length === null) return false;
  return node.children.every((c) => allHaveLengths(c, false));
}

function depthOf(node: TreeNode): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(depthOf));
}

function maxDistance(node: TreeNode, acc: number): number {
  const here = acc;
  return node.children.length === 0 ? here : Math.max(...node.children.map((c) => maxDistance(c, here + (c.length ?? 0))));
}

/** Clean scale-bar length: 1, 2 or 5 x 10^k, about a fifth of the tree. */
function scaleBar(max: number): number {
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
}

export function PhyloTree({ newick, title, isPartial = false }: PhyloTreeProps) {
  const root = parseNewick(newick);
  if (!root) return null;
  const tips = leaves(root);
  const metric = allHaveLengths(root, true);
  const span = metric ? maxDistance(root, 0) || 1 : depthOf(root) || 1;
  const plotW = VB_W - PX0 - LABEL_ROOM;
  const xOf = (units: number) => PX0 + (units / span) * plotW;
  const height = PAD_TOP + tips.length * ROW + (metric ? 30 : 6);

  let leafIndex = 0;
  const place = (node: TreeNode, units: number, depth: number): Placed => {
    // Cladogram: leaves line up at the right edge; internal nodes by depth.
    const x = metric ? xOf(units) : node.children.length === 0 ? xOf(span) : xOf(depth);
    if (node.children.length === 0) {
      const y = PAD_TOP + leafIndex++ * ROW + ROW / 2;
      return { node, x, y, children: [] };
    }
    const kids = node.children.map((c) => place(c, units + (c.length ?? 0), depth + 1));
    const y = (kids[0]!.y + kids[kids.length - 1]!.y) / 2;
    return { node, x, y, children: kids };
  };
  const tree = place(root, 0, 0);

  const branches: Array<{ d: string; key: string }> = [];
  const nodes: Placed[] = [];
  const tipsPlaced: Placed[] = [];
  const walk = (p: Placed) => {
    if (!p.children.length) tipsPlaced.push(p);
    if (p.children.length) {
      nodes.push(p);
      const top = p.children[0]!.y;
      const bottom = p.children[p.children.length - 1]!.y;
      branches.push({ key: `v${p.x},${p.y}`, d: `M${p.x},${top} L${p.x},${bottom}` });
      for (const c of p.children) {
        branches.push({ key: `h${c.x},${c.y}`, d: `M${p.x},${c.y} L${c.x},${c.y}` });
        walk(c);
      }
    }
  };
  walk(tree);

  const bar = metric ? scaleBar(span) : 0;
  const names = tips.map((t) => t.name || "unnamed");
  const aria = `${metric ? "Phylogram" : "Cladogram"} of ${tips.length} taxa: ${names.join(", ")}.`;

  return (
    <FigurePlate
      kicker="Phylogenetics"
      title={title ?? (metric ? "Phylogenetic tree" : "Phylogenetic tree (topology only)")}
      isPartial={isPartial}
      label={aria}
      takeaway={
        metric
          ? <>Branch lengths are drawn to scale: horizontal distance is evolutionary change; vertical spacing means nothing.</>
          : <>No branch lengths were given, so only the branching order is meaningful, not how far apart the tips are.</>
      }
      table={{
        caption: "Taxa in the tree",
        head: ["Taxon", metric ? "Distance from root" : "Depth from root"],
        rows: tips.map((t) => {
          let d = 0;
          let depth = 0;
          const find = (n: TreeNode, acc: number, lvl: number): boolean => {
            if (n === t) { d = acc; depth = lvl; return true; }
            return n.children.some((c) => find(c, acc + (c.length ?? 0), lvl + 1));
          };
          find(root, 0, 0);
          return [t.name || "unnamed", metric ? Number(d.toFixed(4)) : depth];
        }),
        numeric: [false, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${height}`} role="img" aria-label={aria}>
        {branches.map((b) => <path key={b.key} className="gen-branch" d={b.d} />)}
        {nodes.map((n) => <circle key={`n${n.x},${n.y}`} className="gen-node" cx={n.x} cy={n.y} r={2.5} />)}
        {tipsPlaced.map((p) => (
          <text key={`t${p.y}`} className="gen-svg__label" x={p.x + 8} y={p.y + 4}>
            {p.node.name || "unnamed"}
          </text>
        ))}
        {metric ? (
          <g>
            <line className="gen-axis" x1={PX0} y1={height - 14} x2={xOf(bar)} y2={height - 14} />
            <text className="gen-svg__mono" x={xOf(bar) + 6} y={height - 10}>{`${bar} substitutions/site`}</text>
          </g>
        ) : null}
      </svg>
    </FigurePlate>
  );
}
