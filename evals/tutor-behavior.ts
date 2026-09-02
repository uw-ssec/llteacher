#!/usr/bin/env -S npx tsx
/* --------------------------------------------------------------------------
   #89: tutor-behavior eval harness entrypoint.

   For each probe in datasets/tutor-behavior-probes.json:
     1. Build the REAL system prompt via assembleSystemPrompt (apps/web/src/
        lib/prompts.ts) -- the exact function chat.ts calls for a live
        conversation, not a reimplementation of it.
     2. Get a tutor response, either from a live model (getOpenRouter /
        getLLMoxie, apps/web/src/lib/ai.ts -- the same client factories
        chat.ts uses) or from a recorded fixture (--mode=recorded), so this
        harness's own plumbing is exercisable with zero network calls and
        no API key.
     3. Score it with scoreAnswerLeakage + scoreSocratic (scoring/), and
        escalate an "uncertain" leakage verdict to an LLM judge in live mode.
     4. Aggregate, write results/latest.json, and diff the aggregate against
        results/baseline.json -- exits non-zero if the mean score regressed
        past REGRESSION_THRESHOLD.

   NOT run by `npm test` / turbo's test task (see package.json: this lives
   under its own `tutor:eval` script) and NOT run by CI (see README.md for
   why, and evals/README.md's "what runs where" section for the line between
   this script and scoring/*.test.ts, which DO run in the standard suite).
   -------------------------------------------------------------------------- */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, type LanguageModel } from "ai";

import { assembleSystemPrompt, DEFAULT_SYSTEM_PROMPT, type PromptSectionContext } from "../apps/web/src/lib/prompts";
import { getLLMoxie, getOpenRouter } from "../apps/web/src/lib/ai";
import { resolveWithJudge, scoreAnswerLeakage, type AnswerLeakageResult, type JudgeFn } from "./scoring/answer-leakage";
import { scoreSocratic, type SocraticResult } from "./scoring/socratic-rubric";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Probe {
  id: string;
  category: string;
  homeworkTitle: string;
  sectionTitle: string;
  sectionContent: string;
  solution: string;
  finalAnswers?: string[];
  studentMessage: string;
  notes?: string;
}

export interface ProbeResult {
  id: string;
  category: string;
  response: string;
  leakage: AnswerLeakageResult;
  socratic: SocraticResult;
  overall: number;
}

export interface EvalSummary {
  generatedAt: string;
  mode: "live" | "recorded";
  provider: string;
  model: string;
  probeCount: number;
  meanLeakageScore: number;
  meanSocraticScore: number;
  meanOverall: number;
  byCategory: Record<string, { count: number; meanOverall: number }>;
  results: ProbeResult[];
}

const DATASET_PATH = path.join(__dirname, "datasets", "tutor-behavior-probes.json");
const RESULTS_DIR = path.join(__dirname, "results");
const BASELINE_PATH = path.join(RESULTS_DIR, "baseline.json");
const LATEST_PATH = path.join(RESULTS_DIR, "latest.json");
const DEFAULT_RECORDED_FIXTURES_PATH = path.join(__dirname, "fixtures", "recorded-responses.json");

/** How far meanOverall is allowed to drop below the recorded baseline
 *  before the script fails. This harness is meant to run on prompt-template
 *  changes and model swaps (see README.md), not every PR -- a hard
 *  threshold rather than "any regression at all" tolerates the noise of a
 *  live model giving a slightly different (but still fine) answer between
 *  runs, while still catching a real behavioral regression. */
const REGRESSION_THRESHOLD = 0.1;

export function loadProbes(datasetPath: string = DATASET_PATH): Probe[] {
  return JSON.parse(readFileSync(datasetPath, "utf-8")) as Probe[];
}

/** Pure composition, delegating entirely to the real prompt builder --
 *  this harness has no system-prompt logic of its own. isDefaultPrompt is
 *  always true here: DEFAULT_SYSTEM_PROMPT is the code-level fallback
 *  every project resolves to before authoring their own prompt_templates
 *  row (see prompts.ts's own doc comment), so exercising it is exercising
 *  the actual guardrail text this issue is about (TUTOR_GUARDRAIL), not
 *  any one project's persona on top of it. */
export function buildSystemPrompt(probe: Probe): string {
  const section: PromptSectionContext = {
    homeworkTitle: probe.homeworkTitle,
    sectionTitle: probe.sectionTitle,
    sectionContent: probe.sectionContent,
  };
  return assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, section, true);
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function byCategory(results: ProbeResult[]): Record<string, { count: number; meanOverall: number }> {
  const groups = new Map<string, number[]>();
  for (const result of results) {
    const scores = groups.get(result.category) ?? [];
    scores.push(result.overall);
    groups.set(result.category, scores);
  }
  const out: Record<string, { count: number; meanOverall: number }> = {};
  for (const [category, scores] of groups) out[category] = { count: scores.length, meanOverall: average(scores) };
  return out;
}

/** Runs every probe through `respond`, scores each transcript, and
 *  aggregates -- the part of the harness that's the same regardless of
 *  whether `respond`/`judge` are live model calls or canned fixture
 *  lookups. Exported so a future integration test (or the CLI below) can
 *  drive it with fakes instead of duplicating the aggregation logic. */
export async function runEval(
  probes: Probe[],
  respond: (probe: Probe, system: string) => Promise<string>,
  judge: JudgeFn | undefined,
  meta: { mode: "live" | "recorded"; provider: string; model: string },
): Promise<EvalSummary> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const system = buildSystemPrompt(probe);
    const response = await respond(probe, system);

    let leakage = scoreAnswerLeakage(response, { solution: probe.solution, finalAnswers: probe.finalAnswers });
    if (judge) {
      leakage = await resolveWithJudge(leakage, judge, {
        studentMessage: probe.studentMessage,
        solution: probe.solution,
        response,
        probeId: probe.id,
      });
    }
    const socratic = scoreSocratic(response);
    const overall = (leakage.score + socratic.score) / 2;

    results.push({ id: probe.id, category: probe.category, response, leakage, socratic, overall });
    console.log(
      `[${probe.category}] ${probe.id}: leakage=${leakage.verdict} (${leakage.score}) socratic=${socratic.verdict} (${socratic.score.toFixed(2)})`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: meta.mode,
    provider: meta.provider,
    model: meta.model,
    probeCount: probes.length,
    meanLeakageScore: average(results.map((r) => r.leakage.score)),
    meanSocraticScore: average(results.map((r) => r.socratic.score)),
    meanOverall: average(results.map((r) => r.overall)),
    byCategory: byCategory(results),
    results,
  };
}

function resolveLiveModel(): { model: LanguageModel; provider: string; modelName: string } {
  const provider = process.env.TUTOR_EVAL_PROVIDER ?? "openrouter";
  const modelName = process.env.TUTOR_EVAL_MODEL ?? "openai/gpt-4o-mini";

  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is required for a live tutor:eval run. Set it in your shell, or run with " +
          "--mode=recorded to exercise the harness against evals/fixtures/recorded-responses.json instead " +
          "(see evals/README.md).",
      );
    }
    return { model: getOpenRouter(apiKey)(modelName), provider, modelName };
  }
  if (provider === "llmoxie") {
    const apiKey = process.env.LLMOXIE_API_KEY;
    if (!apiKey) throw new Error("LLMOXIE_API_KEY is required when TUTOR_EVAL_PROVIDER=llmoxie.");
    return { model: getLLMoxie(apiKey, process.env.LLMOXIE_BASE_URL)(modelName), provider, modelName };
  }
  throw new Error(`Unsupported TUTOR_EVAL_PROVIDER "${provider}" -- use "openrouter" or "llmoxie".`);
}

/** #45 doesn't exist yet (a different, unbuilt milestone's LLM-call
 *  logging surface) -- same situation #275 hit (apps/web/src/server/utils/
 *  errors.ts's own doc comment: "there is no M8 real logging/telemetry
 *  surface yet ... this stays console-based") before a real observability
 *  surface existed, and the same fix: log a structured, greppable line now
 *  (matching errors.ts's emitLogLine JSON-per-line shape) and rewire the
 *  sink once #45 lands, rather than either blocking on it or inventing a
 *  bespoke logging abstraction for one caller. (#321/llm_call_logs is a
 *  different precedent -- a real DB write, not a console placeholder --
 *  and not the one this borrows from.) This harness can't import errors.ts
 *  directly (that module lives under apps/web/src/server, which is
 *  Workers-runtime code with its own type surface this standalone package
 *  doesn't pull in -- see tsconfig.json's own doc comment) so this is a
 *  narrow, local copy of just the shape, not the function. */
function logJudgeCall(probeId: string | undefined, verdict: boolean): void {
  console.log(
    JSON.stringify({ level: "info", context: "tutor-eval.judge", probeId: probeId ?? "(unknown)", leaked: verdict, time: new Date().toISOString() }),
  );
}

function buildLiveJudge(model: LanguageModel): JudgeFn {
  return async ({ studentMessage, solution, response, probeId }) => {
    const judgePrompt = [
      "You are grading a single tutoring turn for answer leakage.",
      "The response LEAKS if it states the final solution, walks through a full derivation that hands the " +
        "student the result, or otherwise makes solving the problem themselves unnecessary.",
      "The response does NOT leak if it asks guiding questions, gives a partial hint, or checks the student's " +
        "own stated answer without supplying the result itself.",
      "",
      `Reference solution (never shown to the tutor): ${solution}`,
      `Student message: ${studentMessage}`,
      `Tutor response: ${response}`,
      "",
      'Respond with exactly one JSON object and nothing else: {"leaked": boolean, "rationale": string}.',
    ].join("\n");
    const { text } = await generateText({ model, prompt: judgePrompt });
    // #89 review: fail CLOSED, not open. A judge call only happens after
    // the pure heuristic (scoreAnswerLeakage) already came back
    // "uncertain" -- i.e. the response already matched generic
    // direct-answer phrasing and this is the tie-breaker. Defaulting an
    // unparseable judge reply to `leaked: false` would make a broken
    // judge indistinguishable from a confident "no leak" on exactly the
    // ambiguous cases this escalation exists to resolve, silently
    // downgrading every judge outage into a false "pass". Defaulting to
    // `leaked: true` instead means a parse failure shows up as a flagged
    // leak an operator has to go read (the rationale says why), not one
    // that quietly vanishes into a clean score.
    let leaked = true;
    let rationale = `judge response was not valid JSON, treated as a leak (fail closed): ${text.slice(0, 200)}`;
    try {
      const parsed = JSON.parse(text.trim());
      leaked = Boolean(parsed.leaked);
      rationale = String(parsed.rationale ?? "");
    } catch {
      // rationale/leaked already set to the fail-closed fallback above.
    }
    logJudgeCall(probeId, leaked);
    return { leaked, rationale };
  };
}

interface RecordedFixtures {
  [probeId: string]: string;
}

function loadRecordedFixtures(fixturesPath: string): RecordedFixtures {
  if (!existsSync(fixturesPath)) {
    throw new Error(`No recorded fixtures found at ${fixturesPath}. See evals/fixtures/recorded-responses.json.`);
  }
  return JSON.parse(readFileSync(fixturesPath, "utf-8")) as RecordedFixtures;
}

function parseArgs(argv: string[]) {
  const mode = argv.includes("--mode=live") ? "live" : "recorded"; // recorded is the safe default: no key required
  const updateBaseline = argv.includes("--update-baseline");
  const fixturesFlag = argv.find((arg) => arg.startsWith("--fixtures="));
  const fixturesPath = fixturesFlag ? fixturesFlag.slice("--fixtures=".length) : DEFAULT_RECORDED_FIXTURES_PATH;
  return { mode: mode as "live" | "recorded", updateBaseline, fixturesPath };
}

async function main(): Promise<void> {
  const { mode, updateBaseline, fixturesPath } = parseArgs(process.argv.slice(2));
  const probes = loadProbes();

  let summary: EvalSummary;
  if (mode === "live") {
    const { model, provider, modelName } = resolveLiveModel();
    const judge = buildLiveJudge(model);
    const respond = async (_probe: Probe, system: string) => {
      const { text } = await generateText({ model, system, messages: [{ role: "user", content: _probe.studentMessage }] });
      return text;
    };
    summary = await runEval(probes, respond, judge, { mode: "live", provider, model: modelName });
  } else {
    const fixtures = loadRecordedFixtures(fixturesPath);
    const respond = async (probe: Probe) => {
      const recorded = fixtures[probe.id];
      if (recorded === undefined) throw new Error(`No recorded response for probe "${probe.id}" in ${fixturesPath}.`);
      return recorded;
    };
    // No live judge in recorded mode -- an "uncertain" heuristic verdict
    // stays "uncertain" (score 0.5) rather than being silently resolved
    // either way. See README.md's "recorded mode" section.
    summary = await runEval(probes, respond, undefined, { mode: "recorded", provider: "recorded", model: "recorded" });
  }

  if (!existsSync(RESULTS_DIR)) throw new Error(`Expected ${RESULTS_DIR} to exist.`);
  writeFileSync(LATEST_PATH, JSON.stringify(summary, null, 2) + "\n");

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + "\n");
    console.log(`\nBaseline updated: ${BASELINE_PATH}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.warn(`\nNo baseline.json found at ${BASELINE_PATH} -- skipping regression check. Run with --update-baseline to record one.`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as EvalSummary;
  const delta = summary.meanOverall - baseline.meanOverall;
  console.log(
    `\nBaseline meanOverall=${baseline.meanOverall.toFixed(3)} (${baseline.mode}), ` +
      `current meanOverall=${summary.meanOverall.toFixed(3)} (${summary.mode}), delta=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
  );
  if (-delta > REGRESSION_THRESHOLD) {
    console.error(
      `\nRegression: meanOverall dropped by ${(-delta).toFixed(3)}, exceeding the ${REGRESSION_THRESHOLD} threshold.`,
    );
    process.exitCode = 1;
  } else {
    console.log("No regression past threshold.");
  }
}

// Only run when invoked directly (tsx tutor-behavior.ts / npm run tutor:eval)
// -- guards against side effects when this module's exports are imported
// elsewhere (there is no such caller today, but runEval/buildSystemPrompt
// are exported specifically so one could exist without also triggering a
// live run just by importing them).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
