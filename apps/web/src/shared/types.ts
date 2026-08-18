import type { CourseRole } from "../server/middleware/roles";
import type { ConversationKind } from "../db/schema";

export type HelloResponse = {
  message: string;
  ping_id: string;
};

export interface ProfileWithStats {
  userId: string;
  email: string;
  displayName: string | null;
  role: CourseRole | null;
  courseCount: number;
  instructorStats?: { homeworksCreated: number };
  studentStats?: { submissionsCount: number; completedSections: number };
  /** Course(s) where the caller has a non-dropped instructor/ta/admin
   *  membership. Stopgap for apps/admin's course context until #70's real
   *  course switcher lands (see docs/superpowers/plans/2026-08-05-m3-
   *  homeworks-submissions-parity.md, Resolved Design Decision 8) -- do not
   *  extend this into a general course-listing API; that's #68's job.
   *
   *  #172: each entry carries the caller's role *in that course* plus their
   *  granted capabilities. The top-level `role` above is a single
   *  priority-ranked "primary role" across all memberships, which is the
   *  wrong thing to gate a course-scoped UI on -- an instructor in course A
   *  who is a TA in course B has primaryRole "instructor" and would
   *  otherwise be shown authoring controls for B that the server refuses. */
  courses?: CourseMembershipSummary[];
}

/** #172: the caller's standing in one specific course. `canViewSolutions`
 *  and `canViewDrafts` are already resolved server-side -- they are true
 *  unconditionally for instructor/admin and per-grant for `ta`, so the
 *  client never re-derives the policy and the two can't disagree. */
export interface CourseMembershipSummary {
  id: string;
  title: string;
  role: CourseRole;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

/** #172: one TA's raw capability grants, as the instructor-facing editor
 *  sees them. Distinct from CourseMembershipSummary above, which reports the
 *  *resolved* capability for the caller themselves -- here the flags are the
 *  stored grant on someone else's membership, which is what an instructor
 *  toggles. */
export interface TaCapabilityGrantResponse {
  membershipId: string;
  userId: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

export interface CourseTaCapabilitiesResponse extends TaCapabilityGrantResponse {
  /** #172 audit (USE-001): decrypted server-side. An instructor granting the
   *  answer key needs to identify a person, not a UUID. */
  displayName: string;
  email: string;
  /** #210: added by NetID, never signed in. Distinguishes "waiting for them"
   *  from "something is wrong" -- before #210 nothing created a pending TA,
   *  so this was uniformly false. */
  isPending: boolean;
}

export interface CourseTaListResponse {
  tas: CourseTaCapabilitiesResponse[];
}

/** Both optional so one capability can be flipped without restating the
 *  other; the route rejects a body that names neither. */
export interface TaCapabilitiesBody {
  canViewSolutions?: boolean;
  canViewDrafts?: boolean;
}

/* -- #210: add / remove course TAs by NetID -------------------------------- */

import type { AddTaResult } from "../server/repositories/courseMemberships";

export type { AddTaResult };

export interface AddCourseTasBody {
  /** Raw as typed; normalized and validated server-side (lib/netid.ts). */
  netids: string[];
}

/** One result per entered NetID. The response is 200 even when every entry
 *  failed: the request succeeded, and it is the individual NetIDs that did or
 *  did not resolve. */
export interface AddCourseTasResponse {
  results: AddTaResult[];
}

export interface RemoveCourseTaResponse {
  membershipId: string;
}

/* -- #31 / #98 / #170: LLM configuration authoring ------------------------- */

import type { LlmConfigRecord } from "../server/repositories/llmConfigs";

export type { LlmConfigRecord };

export interface LlmConfigListResponse {
  configs: LlmConfigRecord[];
}

/** The create/update body. Deliberately has no credential field: the
 *  platform gateway needs no key from an instructor, and an
 *  instructor-supplied one requires the secret_ref allowlist (#323) first --
 *  without it, choosing which binding to read is choosing from an
 *  environment that holds ENCRYPTION_KEY and SESSION_SECRET. */
export interface LlmConfigBody {
  name: string;
  provider: LlmConfigRecord["provider"];
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  fallbackLlmConfigId: string | null;
  isActive: boolean;
  isDefault: boolean;
}

export interface LlmConfigCloneBody {
  name: string;
}

export interface LlmConfigTestBody {
  message: string;
}

/** The test result is a 200 either way -- a model that refuses is a finding
 *  the instructor needs to read, not a server fault. `ok` discriminates. */
export type LlmConfigTestResponse =
  | {
      ok: true;
      text: string;
      modelName: string;
      usage: { inputTokens: number | null; outputTokens: number | null };
    }
  | { ok: false; modelName: string; error: string };

import type { HomeworkStatus } from "../server/repositories/homeworks";
import type { SectionStatusType, StudentHomeworkSummary } from "../server/repositories/studentHomeworks";

export type { HomeworkStatus };
export type { SectionStatusType, StudentHomeworkSummary };

export interface StudentHomeworkListResponse {
  homeworks: StudentHomeworkSummary[];
}

/* -- Conversations (#4/#5) --------------------------------------------------
   Wire shape of a row from GET /api/conversations -- a projection of the
   `conversations` table, not the raw Drizzle row (#218: the raw row also
   carries ownerUserId/courseId/sectionId/isDeleted/deletedAt, none of which
   any client reads -- every row returned is already scoped to the caller's
   own, so this was never a cross-tenant leak, but it needlessly widened the
   public wire contract). GET/POST/PATCH /api/conversations all project to
   this shape server-side (routes/conversations.ts's toConversationSummary).
   POST's response has no messageCount key at all -- a brand-new conversation
   never has messages yet -- callers (useTutorConversations) default it to 0
   rather than treating its absence as a fetch bug. */
export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListItemResponse extends ConversationSummary {
  messageCount: number;
}

/** Wire shape of GET /api/conversations (#281). `nextCursor` is opaque --
 *  the client only ever echoes it back as the next request's `before` query
 *  param, never parses or reconstructs it itself (that reconstruction, off
 *  a millisecond-truncated `updatedAt.toISOString()`, was the precision-loss
 *  half of #281's bug). `null` means this was the last page. */
export interface ConversationListResponse {
  items: ConversationListItemResponse[];
  nextCursor: string | null;
}

/** Wire shape of a row from GET /api/conversations/:id/messages (#4
 *  fix-round -- added so the tutor-conversations rail's chat column can
 *  seed useChat's `messages` on resume, not just so the UI shows history:
 *  chatHandler builds the model's context from convertToModelMessages
 *  (chat.ts) over exactly the client-sent messages array, so without this
 *  the LLM itself loses all prior context on resume, not just the display).
 *  `parts` is deliberately typed `unknown`, matching how the DB stores it
 *  (jsonb) and how chat.ts's own replayPersistedPart already treats a
 *  persisted row's parts at this boundary -- the client casts it to
 *  @ai-sdk/react's UIMessage['parts'] when seeding useChat, the same
 *  looseness this codebase already accepts elsewhere for this exact field. */
export interface ConversationMessageResponse {
  id: string;
  role: "user" | "assistant" | "system";
  parts: unknown;
  /** #280: the messages cursor (getMessagesForConversation's own `before`
   *  param) is a seq value, but the response previously carried no seq at
   *  all -- a client couldn't construct "give me the page before this one"
   *  from its own response even if it wanted to. Included so a future
   *  caller can page without a second round-trip to look it up. */
  seq: number;
}

export interface SectionResponse {
  id: string;
  title: string;
  content: string;
  order: number;
  type: "conversation" | "non_interactive";
  solution: { id: string; content: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface HomeworkListItemResponse {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  status: HomeworkStatus;
  isHidden: boolean;
  expiresAt: string | null;
  sectionCount: number;
}

/** #165: the authored widget itself (prompts + order) -- distinct from
 *  WidgetResponseResponse, which is a student's recorded pre/post values
 *  for one widget. */
export interface ProgressWidgetResponse {
  id: string;
  prePrompt: string;
  postPrompt: string;
  order: number;
}

export interface HomeworkDetailResponse {
  id: string;
  courseId: string;
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  status: HomeworkStatus;
  publishedAt: string | null;
  releasedAt: string | null;
  isHidden: boolean;
  expiresAt: string | null;
  sections: SectionResponse[];
  widgets: ProgressWidgetResponse[];
  /** Present (true) only in the instructor payload; absent for students. */
  editableBy?: boolean;
}

export interface SectionDiffInput {
  id?: string;
  title: string;
  content: string;
  order: number;
  solutionContent?: string;
  /** Omitted on an existing section leaves its type unchanged; omitted on a
   *  new section defaults to "conversation" (matches planSectionDiff). */
  type?: "conversation" | "non_interactive";
}

export interface ProgressWidgetDiffInput {
  id?: string;
  prePrompt: string;
  postPrompt: string;
  order: number;
}

export interface HomeworkUpdateBody {
  title?: string;
  description?: string;
  dueDate?: string;
  llmConfigId?: string | null;
  sections?: SectionDiffInput[];
  widgets?: ProgressWidgetDiffInput[];
}

export interface HomeworkPublishBody {
  publish: boolean;
  /** ISO datetime. If omitted and publish=true, releases immediately. Must
   *  be in the future if present -- the route rejects a past releasedAt
   *  with 400. */
  releasedAt?: string;
  /** Required to be `true` to unpublish (publish=false) a homework that
   *  already has student activity (#94) -- omitted/false on that request
   *  shape gets a 409 warning instead of applying the transition. Ignored
   *  otherwise. */
  confirm?: boolean;
}

export interface HomeworkPublishResponse {
  id: string;
  publishedAt: string | null;
  releasedAt: string | null;
  /** Present only when this request unpublished a homework that was
   *  currently published -- true/false reports whether it had existing
   *  student activity (conversations against its sections) at the time of
   *  the transition. */
  hadExistingActivity?: boolean;
}

export interface HomeworkHideBody {
  isHidden: boolean;
  /** ISO datetime, or null to explicitly clear. Omit entirely to leave the
   *  existing expiresAt unchanged (mirrors updateHomeworkHideState's
   *  `!== undefined` convention). */
  expiresAt?: string | null;
}

export interface HomeworkHideResponse {
  id: string;
  isHidden: boolean;
  expiresAt: string | null;
}

export interface SubmissionResponse {
  id: string;
  conversationId: string;
  submittedAt: string;
  isResubmission: boolean;
}

export interface SectionAnswerBody {
  content: string;
}

export interface SectionAnswerResponse {
  id: string;
  sectionId: string;
  userId: string;
  content: string;
  submittedAt: string;
  updatedAt: string;
}

export interface WidgetResponseBody {
  which: "pre" | "post";
  /** 0-10 inclusive -- validated server-side, not trusted from the
   *  client-side slider bound. */
  value: number;
}

export interface WidgetResponseResponse {
  id: string;
  widgetId: string;
  userId: string;
  preValue: number | null;
  preSubmittedAt: string | null;
  postValue: number | null;
  postSubmittedAt: string | null;
}

import type {
  HomeworkSubmissionsMatrix,
  ParticipationStatus,
  SubmissionCell,
  StudentSubmissionRow,
} from "../server/repositories/submissions";

export type { ParticipationStatus, SubmissionCell, StudentSubmissionRow };
export type HomeworkSubmissionsResponse = HomeworkSubmissionsMatrix;

// Cloudflare Worker bindings + secrets. Augmented in Phase 1+.
declare global {
  interface Env {
    DATABASE_URL: string;
    WORKOS_API_KEY: string;
    WORKOS_CLIENT_ID: string;
    OPENROUTER_API_KEY: string;
    ASSETS: Fetcher;
    // Auth (M1): sealed session cookie key + IdentityCipher keys.
    SESSION_SECRET: string;
    ENCRYPTION_KEY: string;
    BLIND_INDEX_KEY: string;
    // WorkOS webhook signing secret (issue #95) -- one per WorkOS
    // project/environment, not per-org: WorkOS webhooks are configured
    // once in the dashboard as a single Endpoint delivering events for
    // every organization under that project.
    WORKOS_WEBHOOK_SECRET: string;
  }
}

export {};
