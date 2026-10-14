/* One realistic, valid input per measurement figure tool -- the same JSON a
   model would send. Illustrative numbers for a nursing informatics course,
   not taken from any real unit, survey or patient. Shared by the render
   tests and (via the integrator) the registry and showcase. */

export const MEASUREMENT_FIXTURES: Record<string, unknown> = {
  // Weekly BCMA scanning compliance on a med-surg unit: 8 baseline weeks,
  // then re-education on scanning before administration.
  showRunChart: {
    measure: "BCMA scanning compliance, 4 West",
    improvement: "up",
    changeAfter: "Wk 8",
    changeLabel: "BCMA re-education",
    baselineCount: 8,
    points: [
      { label: "Wk 1", numerator: 352, denominator: 400 },
      { label: "Wk 2", numerator: 360, denominator: 400 },
      { label: "Wk 3", numerator: 350, denominator: 400 },
      { label: "Wk 4", numerator: 358, denominator: 400 },
      { label: "Wk 5", numerator: 364, denominator: 400 },
      { label: "Wk 6", numerator: 354, denominator: 400 },
      { label: "Wk 7", numerator: 362, denominator: 400 },
      { label: "Wk 8", numerator: 356, denominator: 400 },
      { label: "Wk 9", numerator: 366, denominator: 400 },
      { label: "Wk 10", numerator: 360, denominator: 400 },
      { label: "Wk 11", numerator: 370, denominator: 400 },
      { label: "Wk 12", numerator: 372, denominator: 400 },
      { label: "Wk 13", numerator: 368, denominator: 400 },
      { label: "Wk 14", numerator: 376, denominator: 400 },
      { label: "Wk 15", numerator: 374, denominator: 400 },
      { label: "Wk 16", numerator: 380, denominator: 400 },
      { label: "Wk 17", numerator: 378, denominator: 400 },
      { label: "Wk 18", numerator: 382, denominator: 400 },
      { label: "Wk 19", numerator: 376, denominator: 400 },
      { label: "Wk 20", numerator: 384, denominator: 400 },
    ],
  },
  // Twelve med-surg nurses rate a redesigned vital-signs flowsheet.
  showUsabilityScore: {
    systemName: "Flowsheet redesign, med-surg",
    respondents: [
      [4, 2, 4, 2, 4, 2, 4, 4, 4, 2],
      [3, 3, 3, 2, 3, 3, 4, 4, 3, 3],
      [4, 2, 4, 1, 4, 2, 4, 3, 4, 2],
      [2, 3, 3, 2, 3, 3, 3, 4, 3, 3],
      [5, 1, 4, 2, 4, 2, 5, 3, 4, 2],
      [3, 2, 3, 2, 4, 2, 4, 4, 3, 2],
      [4, 2, 4, 3, 3, 2, 4, 3, 4, 3],
      [3, 3, 2, 2, 3, 3, 3, 5, 3, 3],
      [4, 2, 4, 1, 4, 2, 4, 3, 5, 2],
      [4, 2, 3, 2, 4, 3, 4, 4, 4, 2],
      [2, 4, 2, 3, 2, 3, 3, 5, 2, 4],
      [4, 2, 4, 2, 4, 2, 5, 3, 4, 1],
    ],
  },
  // Nurses on a 150-nurse service line taking up secure messaging after go-live.
  showAdoptionCurve: {
    innovation: "Secure messaging",
    staffCount: 150,
    staffLabel: "nurses",
    series: [
      { label: "Week 1", adoptedCount: 2 },
      { label: "Week 2", adoptedCount: 5 },
      { label: "Week 3", adoptedCount: 14 },
      { label: "Week 4", adoptedCount: 26 },
      { label: "Week 5", adoptedCount: 41 },
      { label: "Week 6", adoptedCount: 52 },
      { label: "Week 7", adoptedCount: 60 },
      { label: "Week 8", adoptedCount: 63 },
    ],
  },
};
