/* --------------------------------------------------------------------------
   Bioinformatics computation for the generative-UI figures.

   Every figure computes what it shows from the sequence the model supplied
   -- the translation, the identity, the tree layout -- rather than trusting
   numbers the model wrote alongside it. A model can misremember a codon or
   miscount a gap; it cannot make this code do either.
   -------------------------------------------------------------------------- */

/** The standard genetic code (NCBI translation table 1), DNA codons. */
const STANDARD_CODE: Record<string, string> = (() => {
  const bases = "TCAG";
  // Amino acids in TCAG x TCAG x TCAG order; '*' is a stop codon.
  const aas = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG";
  const table: Record<string, string> = {};
  let i = 0;
  for (const a of bases) for (const b of bases) for (const c of bases) table[a + b + c] = aas[i++]!;
  return table;
})();

const THREE_LETTER: Record<string, string> = {
  A: "Ala", R: "Arg", N: "Asn", D: "Asp", C: "Cys", Q: "Gln", E: "Glu", G: "Gly", H: "His", I: "Ile",
  L: "Leu", K: "Lys", M: "Met", F: "Phe", P: "Pro", S: "Ser", T: "Thr", W: "Trp", Y: "Tyr", V: "Val", "*": "Stop",
};

/** Side-chain property classes, the grouping intro courses teach. Each maps
 *  to one categorical slot so the colour follows the class everywhere. */
export type ResidueClass = "nonpolar" | "polar" | "positive" | "negative" | "special";

const RESIDUE_CLASS: Record<string, ResidueClass> = {
  A: "nonpolar", V: "nonpolar", L: "nonpolar", I: "nonpolar", M: "nonpolar", F: "nonpolar", W: "nonpolar",
  S: "polar", T: "polar", N: "polar", Q: "polar", Y: "polar", C: "polar",
  K: "positive", R: "positive", H: "positive",
  D: "negative", E: "negative",
  G: "special", P: "special",
};

export const RESIDUE_CLASS_LABEL: Record<ResidueClass, string> = {
  nonpolar: "Nonpolar",
  polar: "Polar",
  positive: "Positive charge",
  negative: "Negative charge",
  special: "Glycine / proline",
};

export function residueClass(aa: string): ResidueClass | null {
  return RESIDUE_CLASS[aa] ?? null;
}

/** Strips whitespace and digits (FASTA/GenBank line numbering), upper-cases,
 *  and reports anything that is not a DNA base. RNA input (U) is accepted
 *  and read as T, since students paste both. */
export function normalizeDna(raw: string): { dna: string; invalid: string[] } {
  const cleaned = raw.replace(/[\s\d]/g, "").toUpperCase().replace(/U/g, "T");
  const invalid = [...new Set(cleaned.replace(/[ACGT]/g, "").split(""))];
  return { dna: cleaned.replace(/[^ACGT]/g, ""), invalid };
}

export interface Codon {
  index: number;
  /** 1-based nucleotide position of the codon's first base. */
  start: number;
  dna: string;
  mrna: string;
  aa: string;
  three: string;
  isStart: boolean;
  isStop: boolean;
}

/** Translates the coding strand from `frame` (0, 1 or 2). Stops at the end
 *  of the last complete codon; does not stop at a stop codon, so a figure
 *  can show what follows it (and mark it). */
export function translate(dna: string, frame = 0): Codon[] {
  const codons: Codon[] = [];
  for (let i = frame, n = 0; i + 3 <= dna.length; i += 3, n++) {
    const triplet = dna.slice(i, i + 3);
    const aa = STANDARD_CODE[triplet] ?? "?";
    codons.push({
      index: n,
      start: i + 1,
      dna: triplet,
      mrna: triplet.replace(/T/g, "U"),
      aa,
      three: THREE_LETTER[aa] ?? "???",
      isStart: triplet === "ATG",
      isStop: aa === "*",
    });
  }
  return codons;
}

/* -- Pairwise alignment ---------------------------------------------------- */

export interface AlignmentScheme {
  match: number;
  mismatch: number;
  gap: number;
}

export const DEFAULT_SCHEME: AlignmentScheme = { match: 1, mismatch: -1, gap: -2 };

export type ColumnKind = "match" | "mismatch" | "gap";

export interface AlignmentStats {
  length: number;
  matches: number;
  mismatches: number;
  gaps: number;
  /** Matches over aligned columns, as a percentage (0-100, one decimal). */
  identity: number;
  score: number;
  columns: ColumnKind[];
}

/** Scores an already-aligned pair column by column (linear gap penalty).
 *  A column with a gap in both rows is not meaningful and is rejected by
 *  the caller's validation before this runs. */
export function scoreAlignment(a: string, b: string, scheme: AlignmentScheme = DEFAULT_SCHEME): AlignmentStats {
  const columns: ColumnKind[] = [];
  let matches = 0;
  let mismatches = 0;
  let gaps = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === "-" || y === "-") {
      gaps++;
      columns.push("gap");
    } else if (x === y) {
      matches++;
      columns.push("match");
    } else {
      mismatches++;
      columns.push("mismatch");
    }
  }
  const score = matches * scheme.match + mismatches * scheme.mismatch + gaps * scheme.gap;
  const identity = a.length === 0 ? 0 : Math.round((matches / a.length) * 1000) / 10;
  return { length: a.length, matches, mismatches, gaps, identity, score, columns };
}

/* -- Newick trees ---------------------------------------------------------- */

export interface TreeNode {
  name: string;
  /** Branch length to the parent; null when the tree carries none. */
  length: number | null;
  children: TreeNode[];
}

/** Parses a Newick string ("((A:0.1,B:0.2):0.05,C:0.3);"). Returns null on
 *  anything malformed -- an unbalanced parenthesis, trailing text -- so a
 *  bad tree renders nothing rather than a wrong one. Quoted labels are
 *  supported for names with spaces. */
export function parseNewick(input: string): TreeNode | null {
  const s = input.trim().replace(/;\s*$/, "");
  let i = 0;

  const readName = (): string => {
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated quote");
      const name = s.slice(i + 1, end);
      i = end + 1;
      return name;
    }
    const start = i;
    while (i < s.length && !",():;".includes(s[i]!)) i++;
    return s.slice(start, i).trim().replace(/_/g, " ");
  };

  const readLength = (): number | null => {
    if (s[i] !== ":") return null;
    i++;
    const start = i;
    while (i < s.length && /[0-9eE.+-]/.test(s[i]!)) i++;
    const value = Number(s.slice(start, i));
    if (!Number.isFinite(value) || value < 0) throw new Error("bad branch length");
    return value;
  };

  const readNode = (depth: number): TreeNode => {
    if (depth > 64) throw new Error("tree too deep");
    const children: TreeNode[] = [];
    if (s[i] === "(") {
      i++;
      children.push(readNode(depth + 1));
      while (s[i] === ",") {
        i++;
        children.push(readNode(depth + 1));
      }
      if (s[i] !== ")") throw new Error("unbalanced parentheses");
      i++;
    }
    const name = readName();
    const length = readLength();
    return { name, length, children };
  };

  try {
    const root = readNode(0);
    if (i !== s.length) return null;
    return root;
  } catch {
    return null;
  }
}

export function leaves(node: TreeNode): TreeNode[] {
  return node.children.length === 0 ? [node] : node.children.flatMap(leaves);
}
