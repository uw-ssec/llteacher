/* --------------------------------------------------------------------------
   StandardsMap (`showStandardsMap`) -- clinical data elements mapped to the
   standards that represent or exchange them.

   Elements are grouped by category (terminologies and code sets, nursing
   terminologies, exchange and document structure), then by standard. Each
   standard's steward and purpose come from the figure's own catalog
   (lib/systems.ts), never from the model. A code is shown exactly as given
   and labelled as such: the figure cannot look codes up, so it never
   presents one as verified. An optional exchange standard shows how the
   elements travel between systems.
   -------------------------------------------------------------------------- */

import {
  STANDARD_CATEGORY_LABEL,
  exchangePhrase,
  groupByStandard,
  standardById,
  standardsSentence,
  type MappedElement,
  type StandardCategory,
} from "../../lib/systems";
import { FigurePlate } from "../../figure/FigurePlate";

export interface StandardsMapProps {
  /** e.g. "Admission nursing assessment: vital signs and pain" */
  scenario: string;
  /** 1-12 elements; `standard` is a catalog id. */
  elements: MappedElement[];
  /** How the elements are exchanged: an exchange-category catalog id and a
   *  resource, message or document name, e.g. { standard: "fhir", resource: "Observation" }. */
  exchange?: { standard: string; resource: string };
  isPartial?: boolean;
}

/** Categories take slots 1-3 in the fixed category order. */
const SWATCH: Record<StandardCategory, string> = {
  terminology: "gen-swatch gen-swatch--1",
  nursing: "gen-swatch gen-swatch--2",
  exchange: "gen-swatch gen-swatch--3",
};
const CARD: Record<StandardCategory, string> = {
  terminology: "gen-sy-std gen-sy-std--1",
  nursing: "gen-sy-std gen-sy-std--2",
  exchange: "gen-sy-std gen-sy-std--3",
};

const CODE_CAVEAT = "code as given — verify in the terminology browser";

export function StandardsMap({ scenario, elements, exchange, isPartial = false }: StandardsMapProps) {
  const categories = groupByStandard(elements);
  const sentence = standardsSentence(elements, exchange);
  const ex = exchange ? standardById(exchange.standard) : undefined;
  const coded = elements.filter((e) => e.code).length;

  return (
    <FigurePlate
      kicker="Standards map"
      title={scenario}
      isPartial={isPartial}
      label={`Standards map, ${scenario}: ${sentence}`}
      takeaway={<>{sentence}</>}
      note={
        coded > 0
          ? `Codes are shown exactly as the tutor gave them (${coded} of ${elements.length}); the figure cannot check them against the terminology.`
          : undefined
      }
      table={{
        caption: "Each data element and the standard that represents it",
        head: ["Data element", "Standard", "Code (as given)", "Display"],
        rows: elements.map((e) => [e.element, standardById(e.standard)?.name ?? e.standard, e.code ?? "", e.display ?? ""]),
      }}
    >
      <div className="gen-sy-map">
        {categories.map((c) => (
          <section key={c.category} className="gen-sy-cat" aria-label={STANDARD_CATEGORY_LABEL[c.category]}>
            <h3 className="gen-sy-cat__head">
              <span className={SWATCH[c.category]} aria-hidden="true" />
              {STANDARD_CATEGORY_LABEL[c.category]}
            </h3>
            {c.groups.map((g) => (
              <article key={g.standard.id} className={CARD[g.standard.category]}>
                <header className="gen-sy-std__head">
                  <span className="gen-sy-std__name">{g.standard.name}</span>
                  <span className="gen-sy-std__count">{g.elements.length === 1 ? "1 element" : `${g.elements.length} elements`}</span>
                </header>
                <p className="gen-sy-std__about">
                  <span className="gen-sy-std__steward">{g.standard.steward}.</span> {g.standard.purpose}
                </p>
                <ul className="gen-sy-std__list">
                  {g.elements.map((e) => (
                    <li key={e.index} className="gen-sy-el">
                      <span className="gen-sy-el__name">{e.element}</span>
                      {e.code || e.display ? (
                        <span className="gen-sy-el__code">
                          {e.code ? <code className="gen-sy-el__value">{e.code}</code> : null}
                          {e.display ? <span className="gen-sy-el__display">{e.display}</span> : null}
                          {e.code ? <span className="gen-sy-el__caveat">{CODE_CAVEAT}</span> : null}
                        </span>
                      ) : (
                        <span className="gen-sy-el__caveat">no code given</span>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ))}
        {exchange && ex ? (
          <section className="gen-sy-exchange" aria-label="How the elements are exchanged">
            <h3 className="gen-sy-cat__head">
              <span className={SWATCH.exchange} aria-hidden="true" />
              Exchanged between systems
            </h3>
            <p className="gen-sy-exchange__line">
              <span className="gen-sy-std__name">{ex.name}</span>
              <code className="gen-sy-el__value">{exchange.resource}</code>
            </p>
            <p className="gen-sy-std__about">
              <span className="gen-sy-std__steward">{ex.steward}.</span> {ex.purpose} Here the elements are{" "}
              {exchangePhrase(exchange.standard, exchange.resource)}.
            </p>
          </section>
        ) : null}
      </div>
    </FigurePlate>
  );
}
