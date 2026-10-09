/* One realistic, valid input per health informatics framework figure tool
   -- the same JSON a model would send. Illustrative nursing scenarios, not
   taken from any real patient or published evaluation. Shared by the
   render tests and (via the integrator) the registry and showcase. */

export const FRAMEWORKS_FIXTURES: Record<string, unknown> = {
  // Bar-code medication administration rolled out on a med-surg unit.
  showQuadrupleAim: {
    intervention: "Bar-code medication administration (BCMA) on a med-surg unit",
    aims: {
      patientExperience: {
        effect: "improves",
        rationale: "Scanning the wristband and the dose catches wrong-patient and wrong-dose errors before they reach the patient.",
        measure: "Medication administration errors per 1,000 doses",
      },
      populationHealth: {
        effect: "improves",
        rationale: "Fewer adverse drug events across every patient on the unit, not only the ones a nurse double-checks.",
        measure: "Adverse drug events per 1,000 patient-days",
      },
      costOfCare: {
        effect: "improves",
        rationale: "Each avoided adverse drug event avoids extra days and treatment, after the up-front cost of scanners.",
        measure: "Cost per avoided adverse drug event",
      },
      careTeamWellBeing: {
        effect: "worsens",
        rationale: "Wristbands that will not scan and slow handhelds add steps and push nurses toward workarounds.",
        measure: "Scan failure and override rate; time per med pass",
      },
    },
  },
  // Smart infusion pump alerts overridden on a med-surg unit.
  showSociotechnicalModel: {
    caseTitle: "Smart infusion pump alerts overridden on a med-surg unit",
    findings: [
      { dimension: "infrastructure", role: "contributing", finding: "Pumps are not connected to the EHR, so every dose is programmed by hand." },
      { dimension: "clinicalContent", role: "contributing", finding: "The drug library's soft limits are set so low that routine heparin doses trigger them." },
      { dimension: "interface", role: "contributing", finding: "The alert screen looks the same for a soft limit and a tenfold error." },
      { dimension: "people", role: "protective", finding: "Experienced nurses double-check high-alert drugs at the bedside." },
      { dimension: "workflow", role: "contributing", finding: "Pumps are reprogrammed at the bedside during busy med passes, with no second check." },
      { dimension: "organization", role: "not assessed" },
      { dimension: "measurement", role: "protective", finding: "Pharmacy reviews the pump override logs every month." },
    ],
  },
  // Early signs of sepsis noticed on a night shift.
  showDikw: {
    scenario: "Early signs of sepsis on a night shift",
    examples: {
      data: "HR 118, RR 24, temp 38.6 °C, SBP 94, new confusion",
      information: "Vital signs trending worse over 4 hours; the early-warning score has risen from 2 to 7",
      knowledge: "This pattern in a post-op patient fits sepsis, and every hour of delay to treatment raises mortality",
      wisdom: "Do not wait for the next scheduled check: escalate now and start the sepsis protocol",
    },
    action: "Calls the rapid response team and draws blood cultures and a lactate",
  },
};
