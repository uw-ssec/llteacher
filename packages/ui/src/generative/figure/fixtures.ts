/* One realistic, valid input per subject-figure tool -- the same JSON a
   model would send. Shared by the registry tests, the screenshot showcase
   (scripts/generative-ui-screenshots.mjs) and the end-to-end fake model, so
   all three exercise exactly the same figures. Not shipped to students.
   The clinical informatics pack's fixtures live in fixtures.{clinical,frameworks,measurement,systems}.ts. */

import { CLINICAL_FIXTURES } from "./fixtures.clinical";
import { FRAMEWORKS_FIXTURES } from "./fixtures.frameworks";
import { MEASUREMENT_FIXTURES } from "./fixtures.measurement";
import { SYSTEMS_FIXTURES } from "./fixtures.systems";

export const FIGURE_FIXTURES: Record<string, unknown> = {
  ...CLINICAL_FIXTURES,
  ...FRAMEWORKS_FIXTURES,
  ...MEASUREMENT_FIXTURES,
  ...SYSTEMS_FIXTURES,
  showWorkedSteps: {
    title: "Real GDP from nominal GDP and the deflator",
    steps: [
      { label: "Start from the definition", expression: "GDP deflator = (nominal GDP / real GDP) × 100", explanation: "The deflator measures the price level relative to the base year." },
      { label: "Rearrange for real GDP", expression: "real GDP = nominal GDP / (deflator / 100)" },
      { label: "Substitute", expression: "real GDP = 27,360 / (122.3 / 100)", explanation: "2023 nominal GDP is $27,360 billion; the deflator is 122.3." },
    ],
    result: { label: "Real GDP, 2023", value: "$22,371 billion (2017 dollars)" },
  },
  showMacroModel: {
    model: "ad-as",
    shifts: [{ curve: "AD", direction: "left", reason: "Consumer confidence falls" }],
  },
  showGdpComposition: {
    label: "United States, 2023",
    unit: "trillion dollars",
    consumption: 18.8,
    investment: 4.8,
    government: 4.7,
    netExports: -0.8,
  },
  showMultiplier: { mpc: 0.8, initialChange: 100, rounds: 8, label: "Government spending", unit: "billion dollars" },
  showLaborForce: { label: "United States, Aug 2026", unit: "millions", employed: 161.2, unemployed: 7.1, notInLaborForce: 100.4 },
  showInflation: {
    indexName: "CPI-U",
    series: [
      { period: "2019", value: 255.7 },
      { period: "2020", value: 258.8 },
      { period: "2021", value: 271.0 },
      { period: "2022", value: 292.7 },
      { period: "2023", value: 304.7 },
      { period: "2024", value: 313.7 },
    ],
  },
  showDistribution: {
    distribution: "normal",
    params: { mean: 0, sd: 1 },
    region: { from: 1.96, label: "Upper tail beyond z = 1.96" },
  },
};
