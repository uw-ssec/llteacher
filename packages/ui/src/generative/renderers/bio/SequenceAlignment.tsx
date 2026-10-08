/* --------------------------------------------------------------------------
   SequenceAlignment (`showAlignment`) -- a pairwise alignment, printed the
   way BLAST and EMBOSS print it: name, start position, residues, end
   position, with a match line between the rows ("|" identical, "." a
   mismatch, blank for a gap). Identity, gaps and score are computed from
   the aligned strings under the stated scheme; the model supplies only the
   alignment. Mismatches carry a wash AND a "." in the match line, so the
   state never rests on colour alone.
   -------------------------------------------------------------------------- */

import { DEFAULT_SCHEME, scoreAlignment, type AlignmentScheme, type ColumnKind } from "../../lib/bio";
import { FigurePlate } from "../../figure/FigurePlate";

export interface SequenceAlignmentProps {
  seqA: string;
  seqB: string;
  nameA: string;
  nameB: string;
  kind: "dna" | "protein";
  scheme?: AlignmentScheme;
  isPartial?: boolean;
}

const BLOCK = 50;
const MARK: Record<ColumnKind, string> = { match: "|", mismatch: ".", gap: " " };

/** Residue positions (1-based, gaps not counted) at each block's edges. */
function blockPositions(seq: string, start: number, end: number): [number, number] {
  const before = seq.slice(0, start).replace(/-/g, "").length;
  const inBlock = seq.slice(start, end).replace(/-/g, "").length;
  return [inBlock ? before + 1 : before, before + inBlock];
}

function Residues({ seq, columns, from, to }: { seq: string; columns: ColumnKind[]; from: number; to: number }) {
  // Group consecutive same-kind columns into one span: far fewer nodes than
  // one per residue, and a screen reader reads the run, not each letter.
  const runs: Array<{ kind: ColumnKind; text: string }> = [];
  for (let i = from; i < to; i++) {
    // A residue opposite a gap is a real base (an insertion relative to the
    // other sequence): only the "-" itself is styled as a gap.
    const kind: ColumnKind = seq[i] === "-" ? "gap" : columns[i] === "gap" ? "match" : columns[i]!;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += seq[i];
    else runs.push({ kind, text: seq[i]! });
  }
  return (
    <span className="gen-align__seq">
      {runs.map((r, i) =>
        r.kind === "match" ? (
          <span key={i}>{r.text}</span>
        ) : (
          <span key={i} className={r.kind === "mismatch" ? "gen-res--mismatch" : "gen-res--gap"}>{r.text}</span>
        ),
      )}
    </span>
  );
}

export function SequenceAlignment({ seqA, seqB, nameA, nameB, kind, scheme = DEFAULT_SCHEME, isPartial = false }: SequenceAlignmentProps) {
  const stats = scoreAlignment(seqA, seqB, scheme);
  const blocks: Array<[number, number]> = [];
  for (let s = 0; s < stats.length; s += BLOCK) blocks.push([s, Math.min(stats.length, s + BLOCK)]);
  const unit = kind === "dna" ? "nucleotides" : "residues";
  const aria = `Pairwise ${kind === "dna" ? "DNA" : "protein"} alignment of ${nameA} and ${nameB}: ${stats.length} columns, ${stats.identity}% identity, ${stats.mismatches} mismatches, ${stats.gaps} gap columns, score ${stats.score}.`;

  return (
    <FigurePlate
      kicker={kind === "dna" ? "Sequence alignment · DNA" : "Sequence alignment · protein"}
      title={`${nameA} vs ${nameB}`}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          {stats.matches} of {stats.length} aligned columns are identical (<strong>{stats.identity}% identity</strong>), with{" "}
          {stats.mismatches} mismatch{stats.mismatches === 1 ? "" : "es"} and {stats.gaps} gap column{stats.gaps === 1 ? "" : "s"}.
        </>
      }
      note={`Score ${stats.score} = ${stats.matches} × ${scheme.match} (match) + ${stats.mismatches} × ${scheme.mismatch} (mismatch) + ${stats.gaps} × ${scheme.gap} (gap), linear gap penalty.`}
      table={{
        caption: "Alignment summary",
        head: ["Measure", "Value"],
        rows: [
          ["Aligned columns", stats.length],
          ["Identical", stats.matches],
          ["Mismatches", stats.mismatches],
          ["Gap columns", stats.gaps],
          ["Identity", `${stats.identity}%`],
          ["Score", stats.score],
          [`${nameA} ${unit}`, seqA.replace(/-/g, "").length],
          [`${nameB} ${unit}`, seqB.replace(/-/g, "").length],
        ],
        numeric: [false, true],
      }}
    >
      <dl className="gen-stats">
        <div className="gen-stat"><dt>Identity</dt><dd>{`${stats.identity}%`}</dd></div>
        <div className="gen-stat"><dt>Mismatches</dt><dd>{stats.mismatches}</dd></div>
        <div className="gen-stat"><dt>Gaps</dt><dd>{stats.gaps}</dd></div>
        <div className="gen-stat"><dt>Score</dt><dd>{stats.score}</dd></div>
      </dl>
      <div className="gen-align" role="group" aria-label="Aligned sequences">
        {blocks.map(([from, to]) => {
          const [a0, a1] = blockPositions(seqA, from, to);
          const [b0, b1] = blockPositions(seqB, from, to);
          return (
            <div key={from} className="gen-align__block">
              <span className="gen-align__name">{nameA}</span>
              <span className="gen-align__pos">{a0}</span>
              <Residues seq={seqA} columns={stats.columns} from={from} to={to} />
              <span className="gen-align__pos">{a1}</span>

              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span className="gen-align__marks" aria-hidden="true">
                {stats.columns.slice(from, to).map((k) => MARK[k]).join("")}
              </span>
              <span aria-hidden="true" />

              <span className="gen-align__name">{nameB}</span>
              <span className="gen-align__pos">{b0}</span>
              <Residues seq={seqB} columns={stats.columns} from={from} to={to} />
              <span className="gen-align__pos">{b1}</span>
            </div>
          );
        })}
      </div>
      <ul className="gen-legend">
        <li className="gen-legend__item"><span className="gen-align__marks">|</span><span>identical</span></li>
        <li className="gen-legend__item"><span className="gen-res--mismatch gen-align__marks">.</span><span>mismatch</span></li>
        <li className="gen-legend__item"><span className="gen-align__marks">-</span><span>gap (insertion / deletion)</span></li>
      </ul>
    </FigurePlate>
  );
}
