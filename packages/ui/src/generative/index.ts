/* Generative-UI components — rendered inline inside AI messages when the
   LLM invokes a structured-output tool. */

export { DefinitionCard } from "./DefinitionCard";
export type { DefinitionCardProps } from "./DefinitionCard";
export { renderToolPart, parseShowDefinitionInput, parseExecuteRCodeInput, isToolPart } from "./render";
export type { ToolPart, ToolPartHandlers } from "./render";
export { CodeExecution, renderTextWithCode } from "./renderers/CodeExecution";
export type { CodeExecutionProps, RCodeResult, RenderTextWithCodeOptions } from "./renderers/CodeExecution";
export { SectionCompleteSuggestion } from "./renderers/SectionCompleteSuggestion";
export type { SectionCompleteSuggestionProps } from "./renderers/SectionCompleteSuggestion";
