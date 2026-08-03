/* --------------------------------------------------------------------------
   LLTeacher Design System — v2 component barrel export
   Chat-with-syllabus aesthetic. Geist + UW palette (Husky Purple + Heritage Gold).
   -------------------------------------------------------------------------- */

/* -- App shell components -------------------------------------------------- */

export { TopNav } from "./components/TopNav";
export type { TopNavProps } from "./components/TopNav";

export { Sidebar } from "./components/Sidebar";
export type { SidebarProps, SidebarSection } from "./components/Sidebar";

export { ConversationView } from "./components/ConversationView";
export type { ConversationViewProps, MessageData, AIMessageData, StudentMessageData, SystemMessageData } from "./components/ConversationView";

export { Message } from "./components/Message";
export type { MessageProps, MessageRole } from "./components/Message";

export { Composer } from "./components/Composer";
export type { ComposerProps } from "./components/Composer";

export { CodeBlock } from "./components/CodeBlock";
export type { CodeBlockProps } from "./components/CodeBlock";

export { SectionItem } from "./components/SectionItem";
export type { SectionItemProps, SectionStatus } from "./components/SectionItem";

/* -- Utility components ---------------------------------------------------- */

export { Button } from "./components/Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/Button";

export { Input } from "./components/Input";
export type { InputProps } from "./components/Input";

export { Badge } from "./components/Badge";
export type { BadgeProps, BadgeVariant, BadgeSize } from "./components/Badge";

export { Spinner } from "./components/Spinner";
export type { SpinnerProps, SpinnerSize } from "./components/Spinner";

/* -- Generative-UI surfaces (rendered inline inside AI messages) ----------- */

export { DefinitionCard, renderToolPart } from "./generative";
export type { DefinitionCardProps, ToolPart } from "./generative";

/* -- Auth session -----------------------------------------------------------
   Shared session-fetch-on-mount + login/logout for apps/web and apps/admin.
   Each app wraps createAuthProvider() in its own AuthProvider.tsx to get a
   typed useAuth() -- see apps/web and apps/admin's components/AuthProvider.tsx. */

export { createAuthProvider } from "./auth/createAuthProvider";
export type { AuthSessionState, AuthProviderOptions } from "./auth/createAuthProvider";
