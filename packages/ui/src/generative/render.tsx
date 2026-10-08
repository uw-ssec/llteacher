/* --------------------------------------------------------------------------
   Generative-UI tool renderer registry.

   Maps a UIMessage tool part (`{ type: 'tool-<toolName>', input, state }`)
   to a React node. Returns `null` for tools we don't know about so the
   conversation degrades gracefully when the server's tool catalog grows
   ahead of the client.

   Adding a new tool:
     1. Define the input schema on the server in routes/chat.ts
     2. Build the component in packages/ui/src/generative/
     3. Add a case here
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";
import { DefinitionCard } from "./DefinitionCard";
import { CodeExecution, type RCodeResult } from "./renderers/CodeExecution";
import { SectionCompleteSuggestion } from "./renderers/SectionCompleteSuggestion";
import { isRenderableToolPartType } from "./renderableTools";
import { ToolPartErrorBoundary } from "./ToolPartErrorBoundary";
import { FigureSkeleton } from "./figure/FigurePlate";
import { WorkedSteps } from "./renderers/WorkedSteps";
import { MacroModelDiagram } from "./renderers/econ/MacroModelDiagram";
import { GdpComposition } from "./renderers/econ/GdpComposition";
import { MultiplierRounds } from "./renderers/econ/MultiplierRounds";
import { LaborForce } from "./renderers/econ/LaborForce";
import { PriceIndex } from "./renderers/econ/PriceIndex";
import { DistributionPlot } from "./renderers/stats/DistributionPlot";
import { KnowledgeCheck } from "./renderers/KnowledgeCheck";
import { DiagnosticAccuracy } from "./renderers/clinical/DiagnosticAccuracy";
import { PrevalenceEffect } from "./renderers/clinical/PrevalenceEffect";
import { RocCurve } from "./renderers/clinical/RocCurve";
import { PatientTimeline } from "./renderers/clinical/PatientTimeline";
import { CdsRule } from "./renderers/clinical/CdsRule";
import {
  parseCdsRuleInput,
  parseDiagnosticAccuracyInput,
  parsePatientTimelineInput,
  parsePrevalenceEffectInput,
  parseRocCurveInput,
} from "./toolInputs.clinical";
import {
  parseDistributionInput,
  parseGdpCompositionInput,
  parseInflationInput,
  parseKnowledgeCheckInput,
  parseLaborForceInput,
  parseMacroModelInput,
  parseMultiplierInput,
  parseWorkedStepsInput,
} from "./toolInputs";

/* The minimal shape of a tool part we care about. AI SDK v5 emits parts
   with `type: 'tool-<toolName>'` and a state machine on `state`. */
export interface ToolPart {
  type: string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: unknown;
  /** The AI SDK's id for this call; knowledgeCheck answers reference it. */
  toolCallId?: string;
}

/** Runtime-validates the untrusted `input` of a `tool-showDefinition` part
 *  against the shape `DefinitionCard` expects. `part.input` is model-
 *  generated JSON -- an LLM can (and, per #144, routinely does) emit `term`
 *  as an object or `body` as an array. A raw cast (`as Partial<{ term:
 *  string; body: string }>`, the pre-#144 code here) lets that malformed
 *  shape flow straight into `<DefinitionCard term={term}>` as a JSX child,
 *  where React throws "Objects are not valid as a React child" during
 *  render -- taking down the whole app if nothing catches it.
 *
 *  Mirrors `parseCourseRole`'s deny-by-default pattern (packages/ui/src/
 *  auth/courseRole.ts): every field is checked against its expected runtime
 *  type, and the whole input is rejected (`null`) rather than partially
 *  trusted or coerced the moment anything doesn't match -- including a
 *  present-but-wrong-typed `body`, not just a missing one. Returns `null`
 *  (not a thrown error) both for "still streaming, no term yet" (the
 *  original short-circuit) and for "malformed", so callers keep the
 *  existing "nothing to show yet" behavior for both cases. */
export function parseShowDefinitionInput(
  value: unknown,
): { term: string; body: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { term, body } = value as Record<string, unknown>;
  if (term !== undefined && typeof term !== "string") return null;
  if (body !== undefined && typeof body !== "string") return null;
  /* Don't render anything until we have at least a term to anchor the card
     -- also covers "term omitted entirely" (still streaming its args). */
  if (typeof term !== "string" || term.length === 0) return null;
  return { term, body: typeof body === "string" ? body : "" };
}

/** Narrows an untrusted `UIMessage` part to `ToolPart` without a raw cast.
 *  `useChat()` here isn't given the server's tool-input generics, so
 *  TypeScript's `UIMessagePart` union can't statically prove `tool-*` parts
 *  carry `input`/`state` -- callers previously bridged that gap with `part
 *  as ToolPart`, which type-checks regardless of what the part actually is
 *  at runtime. This checks the one thing actually needed (a string `type`)
 *  before handing the part to `renderToolPart`, which then further
 *  validates the tool-specific `input` shape itself (see
 *  `parseShowDefinitionInput` above) rather than trusting either cast. */
export function isToolPart(part: unknown): part is ToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: unknown }).type === "string"
  );
}

/** Runtime-validates a `tool-executeRCode` part's untrusted `input` --
 *  same deny-by-default reasoning as parseShowDefinitionInput above (the
 *  model's own JSON, not to be trusted verbatim). Only `code` is required;
 *  `showSource` is optional and defaults inside CodeExecution itself. */
export function parseExecuteRCodeInput(
  value: unknown,
): { code: string; showSource?: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, showSource } = value as Record<string, unknown>;
  if (showSource !== undefined && typeof showSource !== "boolean") return null;
  if (typeof code !== "string" || code.length === 0) return null;
  return { code, showSource: typeof showSource === "boolean" ? showSource : undefined };
}

/** Handlers a caller can inject for tool parts whose rendering needs an
 *  app-level side effect this package can't own itself (e.g. executeRCode
 *  needs a real WebR-backed `run`, see CodeExecution's own doc comment for
 *  why that lives in apps/web, not here). Optional and additive --
 *  `renderToolPart(part, key)` with no third argument keeps working
 *  exactly as it did before `tool-executeRCode` existed. */
export interface ToolPartHandlers {
  onRunRCode?: (code: string) => Promise<RCodeResult>;
  /** #36: answers already given in this conversation (toolCallId ->
   *  option index), and how to send a new one. Absent = read-only checks. */
  knowledgeCheck?: {
    answers: ReadonlyMap<string, number>;
    onAnswer?: (toolCallId: string, question: string, options: string[], selectedIndex: number) => Promise<void>;
  };
}

/* Subject figures (shared worked steps, and the subject packs an instructor
   enables): every one is "validate the model's JSON, then draw", so they
   share one table rather than near-identical branches. While the arguments are still
   streaming and don't yet validate, a skeleton plate holds the space;
   once streaming has finished, input that still doesn't validate renders
   nothing (the deny-by-default contract above). */
interface FigureTool<P> {
  kicker: string;
  parse: (input: unknown) => P | null;
  render: (props: P, isPartial: boolean) => ReactNode;
}

function figureTool<P>(tool: FigureTool<P>): FigureTool<unknown> {
  return tool as FigureTool<unknown>;
}

const FIGURE_TOOLS: Record<string, FigureTool<unknown>> = {
  "tool-showWorkedSteps": figureTool({ kicker: "Worked steps", parse: parseWorkedStepsInput, render: (p, partial) => <WorkedSteps {...p} isPartial={partial} /> }),
  "tool-showMacroModel": figureTool({ kicker: "Macro model", parse: parseMacroModelInput, render: (p, partial) => <MacroModelDiagram {...p} isPartial={partial} /> }),
  "tool-showGdpComposition": figureTool({ kicker: "National income", parse: parseGdpCompositionInput, render: (p, partial) => <GdpComposition {...p} isPartial={partial} /> }),
  "tool-showMultiplier": figureTool({ kicker: "Fiscal policy", parse: parseMultiplierInput, render: (p, partial) => <MultiplierRounds {...p} isPartial={partial} /> }),
  "tool-showLaborForce": figureTool({ kicker: "Unemployment", parse: parseLaborForceInput, render: (p, partial) => <LaborForce {...p} isPartial={partial} /> }),
  "tool-showDistribution": figureTool({ kicker: "Probability distribution", parse: parseDistributionInput, render: (p, partial) => <DistributionPlot {...p} isPartial={partial} /> }),
  "tool-showInflation": figureTool({ kicker: "Inflation", parse: parseInflationInput, render: (p, partial) => <PriceIndex {...p} isPartial={partial} /> }),
  "tool-showDiagnosticAccuracy": figureTool({ kicker: "Diagnostic accuracy", parse: parseDiagnosticAccuracyInput, render: (p, partial) => <DiagnosticAccuracy {...p} isPartial={partial} /> }),
  "tool-showPrevalenceEffect": figureTool({ kicker: "Prevalence and predictive value", parse: parsePrevalenceEffectInput, render: (p, partial) => <PrevalenceEffect {...p} isPartial={partial} /> }),
  "tool-showRocCurve": figureTool({ kicker: "ROC curve", parse: parseRocCurveInput, render: (p, partial) => <RocCurve {...p} isPartial={partial} /> }),
  "tool-showPatientTimeline": figureTool({ kicker: "Patient timeline", parse: parsePatientTimelineInput, render: (p, partial) => <PatientTimeline {...p} isPartial={partial} /> }),
  "tool-showCdsRule": figureTool({ kicker: "Decision support rule", parse: parseCdsRuleInput, render: (p, partial) => <CdsRule {...p} isPartial={partial} /> }),
};

/** The figure-tool part types, exported for the registry lockstep test. */
export const FIGURE_TOOL_PART_TYPES: readonly string[] = Object.keys(FIGURE_TOOLS);

/** #38: every tool part renders inside its own error boundary, so one
 *  renderer that throws costs one figure, not the whole transcript. */
export function renderToolPart(part: ToolPart, key: string, handlers?: ToolPartHandlers): ReactNode {
  const node = renderToolPartInner(part, handlers);
  if (node === null) return null;
  return (
    <ToolPartErrorBoundary key={key} toolName={part.type.slice("tool-".length)}>
      {node}
    </ToolPartErrorBoundary>
  );
}

function renderToolPartInner(part: ToolPart, handlers?: ToolPartHandlers): ReactNode {
  // Final review of #307/#342: the same set the SERVER's persistence/replay
  // gate consults (chat.ts's hasRenderableContent). Checked here, ahead of
  // the dispatch, so the set cannot claim a name this function silently
  // returns null for -- see renderableTools.ts for the blank-bubble bug
  // that divergence produced.
  if (!isRenderableToolPartType(part.type)) return null;
  if (part.type === "tool-showDefinition") {
    const input = parseShowDefinitionInput(part.input);
    if (!input) return null;
    return (
      <DefinitionCard
        term={input.term}
        body={input.body}
        isPartial={part.state === "input-streaming"}
      />
    );
  }
  if (part.type === "tool-executeRCode") {
    const input = parseExecuteRCodeInput(part.input);
    if (!input) return null;
    return (
      <CodeExecution
        code={input.code}
        showSource={input.showSource}
        isPartial={part.state === "input-streaming"}
        onRun={handlers?.onRunRCode}
      />
    );
  }
  // #168: markSectionComplete is a zero-argument tool -- there is no
  // model-generated `input` to validate (unlike showDefinition/
  // executeRCode above), so this renders on any state, same as requestHint
  // has no renderer at all because it has no display purpose. A stray
  // tool-markSectionComplete part on a replayed/persisted message (this
  // function also runs during replay, via replayPersistedPart's own
  // tool-input-available/tool-output-available writes) still renders the
  // same suggestion card it did live.
  if (part.type === "tool-markSectionComplete") {
    return <SectionCompleteSuggestion isPartial={part.state === "input-streaming"} />;
  }
  // #36: interactive, so it needs the call id (answers reference it) and the
  // app's send path; without either it renders read-only.
  if (part.type === "tool-knowledgeCheck") {
    const isPartial = part.state === "input-streaming";
    const input = parseKnowledgeCheckInput(part.input);
    if (!input) return isPartial ? <FigureSkeleton kicker="Check your understanding" /> : null;
    const callId = part.toolCallId;
    const kc = handlers?.knowledgeCheck;
    const onAnswer = callId && kc?.onAnswer
      ? (index: number) => kc.onAnswer!(callId, input.question, input.options, index)
      : undefined;
    return (
      <KnowledgeCheck
        question={input.question}
        options={input.options}
        answeredIndex={callId ? kc?.answers.get(callId) : undefined}
        onAnswer={onAnswer}
        isPartial={isPartial}
      />
    );
  }
  const figure = FIGURE_TOOLS[part.type];
  if (figure) {
    const isPartial = part.state === "input-streaming";
    const input = figure.parse(part.input);
    if (!input) return isPartial ? <FigureSkeleton kicker={figure.kicker} /> : null;
    return figure.render(input, isPartial);
  }
  return null;
}
