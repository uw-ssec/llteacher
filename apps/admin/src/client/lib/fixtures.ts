/* --------------------------------------------------------------------------
   Fixture data for the admin console. Shapes mirror the Django models in
   apps/{homeworks,llm,accounts,conversations}/src/models.py so the admin
   UI can be wired to a real backend without changing component contracts.

   When the Drizzle schema lands (Phase 1), replace these fixtures with
   real queries — the TypeScript types here are the contract.
   -------------------------------------------------------------------------- */

/* -- Domain types ---------------------------------------------------------- */

export type Teacher = {
  id: string;
  name: string;
  email: string;
};

export type Student = {
  id: string;
  name: string;
  initials: string;
  email: string;
};

export type LLMConfig = {
  id: string;
  /** Display index for the catalog ID badge — `CFG·001` */
  recordNumber: number;
  name: string;
  modelName: string;
  /** First 100 chars of the system prompt for list display */
  basePromptPreview: string;
  temperature: number;
  maxCompletionTokens: number;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
};

export type SectionSummary = {
  id: string;
  homeworkId: string;
  title: string;
  order: number;
  hasSolution: boolean;
  /** How many students have submitted this section */
  submissionsCount: number;
  type: "conversation" | "non_interactive";
};

export type SectionDetail = SectionSummary & {
  content: string;
  solutionContent?: string;
};

export type Homework = {
  id: string;
  /** Display index for the catalog ID badge — `HW·003` */
  recordNumber: number;
  title: string;
  description: string;
  dueDate: string; // ISO
  llmConfigId: string | null;
  sections: SectionSummary[];
  status: "draft" | "scheduled" | "active" | "past_due" | "archived";
  studentsTotal: number;
  studentsActive: number;
  submissionsCount: number;
  lastActivity: string;
};

export type SectionProgressState = "missing" | "in_progress" | "submitted";

export type SubmissionRow = {
  studentId: string;
  studentName: string;
  studentInitials: string;
  /** Per-section progress, indexed by section.order */
  sectionsProgress: { sectionNumber: number; state: SectionProgressState }[];
  conversationCount: number;
  status: "no_interaction" | "partial" | "active";
  /** Display-formatted relative time, e.g. "2h ago" or "—" */
  lastActivity: string | null;
};

/* -- Fixture data ---------------------------------------------------------- */

export const CURRENT_TEACHER: Teacher = {
  id: "teacher-001",
  name: "Anjali Chen",
  email: "achen@uw.edu",
};

export const LLM_CONFIGS: LLMConfig[] = [
  {
    id: "llm-001",
    recordNumber: 1,
    name: "Socratic Default",
    modelName: "gpt-4o-mini",
    basePromptPreview:
      "You are an AI tutor helping students learn. Your role is to guide students through problems without giving away the complete answer…",
    temperature: 0.7,
    maxCompletionTokens: 1000,
    isDefault: true,
    isActive: true,
    createdAt: "2026-03-15",
  },
  {
    id: "llm-002",
    recordNumber: 2,
    name: "Gemma Free Tier",
    modelName: "google/gemma-4-31b-it:free",
    basePromptPreview:
      "You are an AI tutor for an introductory statistics course at the University of Washington. Guide students using the Socratic method…",
    temperature: 0.6,
    maxCompletionTokens: 1200,
    isDefault: false,
    isActive: true,
    createdAt: "2026-05-28",
  },
  {
    id: "llm-003",
    recordNumber: 3,
    name: "Conceptual Only — no R",
    modelName: "gpt-4o-mini",
    basePromptPreview:
      "You are a statistics tutor. Focus on conceptual reasoning. Do not generate R code under any circumstances — refer students to office hours…",
    temperature: 0.4,
    maxCompletionTokens: 800,
    isDefault: false,
    isActive: false,
    createdAt: "2026-04-02",
  },
];

const SECTION_FIXTURES_BY_HW: Record<string, SectionSummary[]> = {
  "hw-001": [
    { id: "s-101", homeworkId: "hw-001", title: "Sample spaces", order: 1, hasSolution: true, submissionsCount: 31, type: "conversation" },
    { id: "s-102", homeworkId: "hw-001", title: "Events and probability", order: 2, hasSolution: true, submissionsCount: 29, type: "conversation" },
    { id: "s-103", homeworkId: "hw-001", title: "Conditional probability", order: 3, hasSolution: true, submissionsCount: 28, type: "conversation" },
  ],
  "hw-002": [
    { id: "s-201", homeworkId: "hw-002", title: "Discrete random variables", order: 1, hasSolution: true, submissionsCount: 26, type: "conversation" },
    { id: "s-202", homeworkId: "hw-002", title: "Continuous random variables", order: 2, hasSolution: true, submissionsCount: 25, type: "conversation" },
    { id: "s-203", homeworkId: "hw-002", title: "Expectation and variance", order: 3, hasSolution: false, submissionsCount: 24, type: "conversation" },
    { id: "s-204", homeworkId: "hw-002", title: "Joint distributions", order: 4, hasSolution: true, submissionsCount: 22, type: "conversation" },
  ],
  "hw-003": [
    { id: "s-301", homeworkId: "hw-003", title: "Random variables", order: 1, hasSolution: true, submissionsCount: 18, type: "conversation" },
    { id: "s-302", homeworkId: "hw-003", title: "Probability distributions", order: 2, hasSolution: true, submissionsCount: 14, type: "conversation" },
    { id: "s-303", homeworkId: "hw-003", title: "P-values", order: 3, hasSolution: true, submissionsCount: 6, type: "conversation" },
    { id: "s-304", homeworkId: "hw-003", title: "Confidence intervals", order: 4, hasSolution: false, submissionsCount: 0, type: "conversation" },
    { id: "s-305", homeworkId: "hw-003", title: "Hypothesis testing", order: 5, hasSolution: false, submissionsCount: 0, type: "conversation" },
  ],
  "hw-004": [
    { id: "s-401", homeworkId: "hw-004", title: "Sampling distributions", order: 1, hasSolution: false, submissionsCount: 0, type: "conversation" },
    { id: "s-402", homeworkId: "hw-004", title: "Central limit theorem", order: 2, hasSolution: false, submissionsCount: 0, type: "conversation" },
    { id: "s-403", homeworkId: "hw-004", title: "Standard error", order: 3, hasSolution: false, submissionsCount: 0, type: "conversation" },
  ],
  "hw-005": [
    { id: "s-501", homeworkId: "hw-005", title: "Two-sample tests", order: 1, hasSolution: false, submissionsCount: 0, type: "conversation" },
    { id: "s-502", homeworkId: "hw-005", title: "Chi-squared tests", order: 2, hasSolution: false, submissionsCount: 0, type: "conversation" },
  ],
};

export const HOMEWORKS: Homework[] = [
  {
    id: "hw-001",
    recordNumber: 1,
    title: "Probability foundations",
    description: "Sample spaces, events, conditional probability, and Bayes' rule with worked examples.",
    dueDate: "2026-04-12",
    llmConfigId: "llm-001",
    sections: SECTION_FIXTURES_BY_HW["hw-001"]!,
    status: "archived",
    studentsTotal: 32,
    studentsActive: 31,
    submissionsCount: 88,
    lastActivity: "2026-04-12",
  },
  {
    id: "hw-002",
    recordNumber: 2,
    title: "Random variables and distributions",
    description: "Discrete vs. continuous random variables, expectation, variance, and joint distributions.",
    dueDate: "2026-05-10",
    llmConfigId: "llm-001",
    sections: SECTION_FIXTURES_BY_HW["hw-002"]!,
    status: "archived",
    studentsTotal: 32,
    studentsActive: 30,
    submissionsCount: 97,
    lastActivity: "2026-05-10",
  },
  {
    id: "hw-003",
    recordNumber: 3,
    title: "Probability and Distributions",
    description: "Random variables, probability distributions, p-values, confidence intervals, and hypothesis testing.",
    dueDate: "2026-06-09",
    llmConfigId: "llm-002",
    sections: SECTION_FIXTURES_BY_HW["hw-003"]!,
    status: "active",
    studentsTotal: 32,
    studentsActive: 24,
    submissionsCount: 38,
    lastActivity: "1h ago",
  },
  {
    id: "hw-004",
    recordNumber: 4,
    title: "Sampling and the CLT",
    description: "Sampling distributions, the central limit theorem, and standard error.",
    dueDate: "2026-06-23",
    llmConfigId: null,
    sections: SECTION_FIXTURES_BY_HW["hw-004"]!,
    status: "draft",
    studentsTotal: 32,
    studentsActive: 0,
    submissionsCount: 0,
    lastActivity: "—",
  },
  {
    id: "hw-005",
    recordNumber: 5,
    title: "Two-sample inference",
    description: "Two-sample t-tests, chi-squared tests, and effect size reporting.",
    dueDate: "2026-07-07",
    llmConfigId: null,
    sections: SECTION_FIXTURES_BY_HW["hw-005"]!,
    status: "scheduled",
    studentsTotal: 32,
    studentsActive: 0,
    submissionsCount: 0,
    lastActivity: "—",
  },
];

/* Per-student submission rows for HW 3 (the active homework) */
export const SUBMISSIONS_HW_003: SubmissionRow[] = [
  mkRow("stu-001", "Aiden Park",        "AP", [1,1,1,0,0], 7,  "active",         "12m ago"),
  mkRow("stu-002", "Bea Sandoval",      "BS", [1,1,1,0,0], 6,  "active",         "34m ago"),
  mkRow("stu-003", "Carlos Mendoza",    "CM", [1,1,2,0,0], 8,  "active",         "1h ago"),
  mkRow("stu-004", "Devi Krishnan",     "DK", [1,1,1,0,0], 5,  "active",         "2h ago"),
  mkRow("stu-005", "Elena Vasquez",     "EV", [1,1,2,0,0], 9,  "active",         "3h ago"),
  mkRow("stu-006", "Fatima Al-Khouri",  "FA", [1,1,2,0,0], 6,  "active",         "5h ago"),
  mkRow("stu-007", "Gabriel Tanaka",    "GT", [1,2,0,0,0], 3,  "partial",        "8h ago"),
  mkRow("stu-008", "Hana Liu",          "HL", [1,1,2,0,0], 4,  "active",         "1d ago"),
  mkRow("stu-009", "Idris Mohamed",     "IM", [1,2,0,0,0], 2,  "partial",        "2d ago"),
  mkRow("stu-010", "Jade Okafor",       "JO", [1,1,0,0,0], 3,  "active",         "2d ago"),
  mkRow("stu-011", "Kai Yoshida",       "KY", [1,0,0,0,0], 1,  "partial",        "3d ago"),
  mkRow("stu-012", "Lucia Romano",      "LR", [0,0,0,0,0], 0,  "no_interaction", null),
  mkRow("stu-013", "Mateo Rivera",      "MR", [0,0,0,0,0], 0,  "no_interaction", null),
  mkRow("stu-014", "Nia Adeyemi",       "NA", [0,0,0,0,0], 0,  "no_interaction", null),
];

function mkRow(
  id: string,
  name: string,
  initials: string,
  progressCodes: number[], // 0=missing, 1=submitted, 2=in_progress
  conversationCount: number,
  status: SubmissionRow["status"],
  lastActivity: string | null,
): SubmissionRow {
  const codeToState = (n: number): SectionProgressState =>
    n === 1 ? "submitted" : n === 2 ? "in_progress" : "missing";
  return {
    studentId: id,
    studentName: name,
    studentInitials: initials,
    sectionsProgress: progressCodes.map((c, i) => ({
      sectionNumber: i + 1,
      state: codeToState(c),
    })),
    conversationCount,
    status,
    lastActivity,
  };
}
