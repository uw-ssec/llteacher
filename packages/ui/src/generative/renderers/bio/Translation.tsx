/* --------------------------------------------------------------------------
   Translation (`showTranslation`) -- the central dogma, one codon at a time.

   The coding strand is read in the chosen frame: each cell shows the DNA
   codon, its mRNA, and the amino acid the STANDARD GENETIC CODE assigns --
   computed here, never taken from the model, which is exactly where a model
   slips (a misremembered codon). A colour bar groups residues by side-chain
   class; the class is also in the legend and the table, so colour is never
   the only cue. Start (ATG) and stop codons are marked in words.
   -------------------------------------------------------------------------- */

import { RESIDUE_CLASS_LABEL, residueClass, translate, type ResidueClass } from "../../lib/bio";
import { FigurePlate, SWATCH, type Slot } from "../../figure/FigurePlate";

export interface TranslationProps {
  dna: string;
  frame?: 0 | 1 | 2;
  label?: string;
  isPartial?: boolean;
}

const CLASS_SLOT: Record<ResidueClass, Slot> = { nonpolar: 1, polar: 2, positive: 3, negative: 4, special: 5 };
const BAR = {
  1: "gen-codon__bar gen-codon__bar--1",
  2: "gen-codon__bar gen-codon__bar--2",
  3: "gen-codon__bar gen-codon__bar--3",
  4: "gen-codon__bar gen-codon__bar--4",
  5: "gen-codon__bar gen-codon__bar--5",
} as const;

export function Translation({ dna, frame = 0, label, isPartial = false }: TranslationProps) {
  const codons = translate(dna, frame);
  const firstStop = codons.findIndex((c) => c.isStop);
  const coding = firstStop === -1 ? codons : codons.slice(0, firstStop);
  const protein = codons.map((c) => c.aa).join("");
  const present = new Set(codons.map((c) => residueClass(c.aa)));
  // Legend in the fixed categorical order, never order of appearance.
  const usedClasses = (Object.keys(CLASS_SLOT) as ResidueClass[]).filter((c) => present.has(c));
  const leftover = (dna.length - frame) % 3;
  const aria = `Translation of ${label ?? "a DNA sequence"} in frame ${frame + 1}: ${codons.length} codons, protein ${protein.replace(/\*/g, " stop ")}.`;

  return (
    <FigurePlate
      kicker="Central dogma · translation"
      title={label ? `Translating ${label}` : "DNA → mRNA → protein"}
      isPartial={isPartial}
      label={aria}
      takeaway={
        firstStop === -1 ? (
          <>{codons.length} codons translate to <strong>{coding.length} amino acids</strong> with no stop codon in this stretch.</>
        ) : (
          <>
            Translation runs {coding.length} amino acid{coding.length === 1 ? "" : "s"} and ends at the{" "}
            <strong>{codons[firstStop]!.dna}</strong> stop codon at position {codons[firstStop]!.start}.
          </>
        )
      }
      note={`Reading frame ${frame + 1}, standard genetic code.${leftover ? ` The last ${leftover} nucleotide${leftover === 1 ? "" : "s"} do not complete a codon.` : ""}`}
      table={{
        caption: "Codon by codon",
        head: ["Position", "DNA", "mRNA", "Amino acid", "Class"],
        rows: codons.map((c) => {
          const cls = residueClass(c.aa);
          return [c.start, c.dna, c.mrna, c.isStop ? "Stop" : `${c.three} (${c.aa})`, cls ? RESIDUE_CLASS_LABEL[cls] : "—"];
        }),
        numeric: [true, false, false, false, false],
      }}
    >
      <ol className="gen-codons" aria-label="Codons">
        {codons.map((c) => {
          const cls = residueClass(c.aa);
          return (
            <li
              key={c.index}
              className={c.isStop ? "gen-codon gen-codon--stop" : c.isStart ? "gen-codon gen-codon--start" : "gen-codon"}
              aria-label={`Position ${c.start}: ${c.dna}, mRNA ${c.mrna}, ${c.isStop ? "stop" : c.three}${c.isStart ? ", start codon" : ""}`}
            >
              <span className="gen-codon__pos" aria-hidden="true">{c.start}</span>
              <span className="gen-codon__dna" aria-hidden="true">{c.dna}</span>
              <span className="gen-codon__mrna" aria-hidden="true">{c.mrna}</span>
              <span className="gen-codon__aa" aria-hidden="true">{c.isStop ? "Stop" : c.three}</span>
              <span className="gen-codon__tag" aria-hidden="true">{c.isStart ? "START" : c.isStop ? "STOP" : c.aa}</span>
              <span className={cls ? BAR[CLASS_SLOT[cls]] : "gen-codon__bar"} aria-hidden="true" />
            </li>
          );
        })}
      </ol>
      <p className="gen-protein">
        <span className="gen-protein__label">Protein</span>
        {protein.replace(/\*/g, "·")}
      </p>
      <ul className="gen-legend">
        {usedClasses.map((cls) => (
          <li key={cls} className="gen-legend__item">
            <span className={SWATCH[CLASS_SLOT[cls]]} aria-hidden="true" />
            <span>{RESIDUE_CLASS_LABEL[cls]}</span>
          </li>
        ))}
      </ul>
    </FigurePlate>
  );
}
