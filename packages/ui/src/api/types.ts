/* --------------------------------------------------------------------------
   The admin API wire contract (#33).

   Why this lives in packages/ui rather than in either app:

   apps/admin has a standing convention that it never imports from apps/web,
   and it is a good one -- they are separately deployed bundles and a direct
   import would let a server-only module (Drizzle, node crypto, the identity
   cipher) reach a browser build. The cost of that convention was that every
   payload shape existed twice, hand-written, once per app. #33 names the
   consequence: the fixture types were "the Drizzle contract" in a comment
   and nothing enforced it, so drift was invisible until a runtime parse
   failed.

   @llteacher/ui is the surface both apps already share. Putting the wire
   types here makes the duplication impossible rather than discouraged:
   apps/web's repositories are checked against these with `satisfies`, and
   apps/admin's client parses into them. One definition, two consumers,
   neither importing the other.

   These are TYPES ONLY -- no runtime code, no dependencies. A payload shape
   is not a component.
   -------------------------------------------------------------------------- */

/** ISO 8601, always UTC, always a string on the wire. Dates cross the
 *  boundary as strings because JSON has no date type and every previous
 *  hand-written duplicate of these shapes disagreed about whether the field
 *  was a Date or a string. */
export type IsoDateTime = string;

/* -- LLM configuration (#31, #98, #170) ------------------------------------ */

export type LlmProvider =
  | "openai"
  | "anthropic"
  | "claude_for_education"
  | "openrouter"
  | "local"
  // #317/#363 merge: kept in step with llmProviderEnum (apps/web's
  // db/schema/content.ts). Migration 0035 makes this every organization's
  // default provider, so the console must be able to name it -- the
  // _RecordMatchesWire guard in repositories/llmConfigs.ts is what caught
  // its absence when the two branches met.
  | "llmoxie";

export interface LlmConfigPayload {
  id: string;
  /** Per-organization display ordinal for the `CFG·001` catalog badge.
   *  Computed at read time from created_at ordering, never stored -- see
   *  repositories/llmConfigs.ts for the rule and its consequences. */
  recordNumber: number;
  name: string;
  provider: LlmProvider;
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  fallbackLlmConfigId: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface LlmConfigListPayload {
  configs: LlmConfigPayload[];
}

export interface LlmConfigWriteBody {
  name: string;
  provider: LlmProvider;
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  fallbackLlmConfigId: string | null;
  isActive: boolean;
  isDefault: boolean;
}

/** The test button's result. 200 either way: a model that refuses is a
 *  finding the instructor needs to read, not a server fault. */
export type LlmConfigTestPayload =
  | {
      ok: true;
      text: string;
      modelName: string;
      usage: { inputTokens: number | null; outputTokens: number | null };
    }
  | { ok: false; modelName: string; error: string };

/* -- Course TAs (#172, #210) ----------------------------------------------- */

export interface CourseTaPayload {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  /** Added by NetID, never signed in. */
  isPending: boolean;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

export type AddTaStatus =
  | "added"
  | "restored"
  | "already_ta"
  | "invalid_netid"
  | "role_conflict";

export interface AddTaResultPayload {
  netid: string;
  status: AddTaStatus;
  membershipId?: string;
  existingRole?: string;
}

/* -- Roster (#32, #86) ----------------------------------------------------- */

export type RosterMemberStatus = "active" | "pending" | "dropped";

export interface RosterMemberPayload {
  membershipId: string;
  userId: string;
  /** Decrypted server-side. Empty until the person's first login supplies
   *  one, which is exactly the `pending` case. */
  displayName: string;
  email: string;
  /** Derived display only -- never a stored column. */
  initials: string;
  role: "student" | "ta" | "instructor" | "admin" | "observer";
  status: RosterMemberStatus;
  enrolledAt: IsoDateTime;
  lastLoginAt: IsoDateTime | null;
  droppedAt: IsoDateTime | null;
}

export interface RosterListPayload {
  members: RosterMemberPayload[];
  /** Total before any filter, so the console can say "3 of 84" honestly. */
  total: number;
}

export type RosterRowStatus =
  | "added"
  | "restored"
  | "already_enrolled"
  | "invalid_email"
  | "disallowed_domain"
  | "duplicate_row"
  | "role_conflict";

/** One CSV row's fate. Same per-row shape as #210's NetID results, and for
 *  the same reason: a single collective "failed" is unusable when four rows
 *  of eighty were malformed. */
export interface RosterImportRowPayload {
  /** 1-based line number in the uploaded file, header excluded, so the
   *  instructor can find the row in their spreadsheet. */
  line: number;
  email: string;
  name: string;
  role: string;
  status: RosterRowStatus;
  membershipId?: string;
  message?: string;
}

export interface RosterImportPayload {
  rows: RosterImportRowPayload[];
  /** True when this was a dry run -- nothing was written. */
  preview: boolean;
  added: number;
  restored: number;
  failed: number;
}

/* -- Grading (#75) --------------------------------------------------------- */

export type GraderType = "human" | "ai";

export interface GradePayload {
  id: string;
  submissionId: string;
  score: number | null;
  maxScore: number | null;
  feedback: string;
  graderType: GraderType;
  /** Decrypted display name of the human grader; empty for an AI draft. */
  graderName: string;
  /** The AI draft this human grade was built from, when there was one. */
  supersedesGradeId: string | null;
  /** True for the grade currently in force -- the most recent human grade
   *  on the submission. History is preserved, so several rows are normal. */
  isCurrent: boolean;
  createdAt: IsoDateTime;
}

export interface GradeListPayload {
  grades: GradePayload[];
}

/** An AI-drafted grade. Never final: it is stored as a draft and an
 *  instructor must approve or edit it into a human grade. */
export interface GradeDraftPayload {
  draftGradeId: string;
  score: number | null;
  maxScore: number | null;
  rationale: string;
  modelName: string;
}

/* -- Export (#91) ---------------------------------------------------------- */

export type ExportFormat = "csv" | "json";
export type ExportSubject = "submissions" | "grades" | "transcripts";

export interface ExportRequestBody {
  subject: ExportSubject;
  format: ExportFormat;
  /** Absent means the whole course. Present narrows to one student, for the
   *  grade-dispute case. */
  studentId?: string;
}

/* ---------- Knowledge management (#42) ---------- */

export type MaterialStatus = "pending" | "processing" | "ready" | "failed";
export type MaterialSourceType = "pdf" | "slides" | "transcript" | "syllabus" | "other";
export type KnowledgeIndexStatus = "pending" | "indexed" | "failed";
export type KnowledgeDocumentKind = "concept" | "index" | "log";

export interface MaterialPayload {
  id: string;
  title: string;
  sourceType: MaterialSourceType;
  originalFilename: string | null;
  byteSize: number | null;
  contentType: string | null;
  status: MaterialStatus;
  errorDetail: string | null;
  uploadedAt: IsoDateTime;
}

export interface MaterialListPayload {
  materials: MaterialPayload[];
}

export interface KnowledgeDocumentSummaryPayload {
  id: string;
  path: string;
  kind: KnowledgeDocumentKind;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  indexStatus: KnowledgeIndexStatus;
  sourceMaterialId: string | null;
  updatedAt: IsoDateTime;
}

export interface KnowledgeDocumentListPayload {
  documents: KnowledgeDocumentSummaryPayload[];
}

export interface KnowledgeDocumentPayload extends KnowledgeDocumentSummaryPayload {
  body: string;
  bodyOriginal: string | null;
  frontmatter: unknown;
  editedAt: IsoDateTime | null;
}

export interface KnowledgeDocumentWriteBody {
  path?: string;
  type?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  body?: string;
}

export interface DocumentLinksPayload {
  outbound: Array<{
    rawHref: string;
    targetPath: string;
    resolvedDocumentId: string | null;
    isBroken: boolean;
  }>;
  backlinks: Array<{ sourceDocumentId: string; sourcePath: string }>;
}

export interface CollectionPayload {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  directoryCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CollectionListPayload {
  collections: CollectionPayload[];
}

export interface CollectionWriteBody {
  name: string;
  description?: string | null;
}

/** Exactly one field set, mirroring the collection_items CHECK. */
export type CollectionItemBody =
  | { documentId: string; directoryPath?: never }
  | { directoryPath: string; documentId?: never };

export interface CollectionItemsWriteBody {
  items: CollectionItemBody[];
}

/** The read side of CollectionItemsWriteBody: what is currently selected,
 *  document-vs-directory preserved, so the editor can restore its checkboxes
 *  rather than reconstructing state from the resolved document list. */
export interface CollectionItemsPayload {
  items: CollectionItemBody[];
}

export type AttachmentScopePayload =
  | { kind: "course"; courseId: string }
  | { kind: "homework"; homeworkId: string }
  | { kind: "section"; sectionId: string }
  | { kind: "llmConfig"; llmConfigId: string };

export interface AttachmentPayload {
  id: string;
  collectionId: string;
  scope: AttachmentScopePayload;
}

export interface AttachmentListPayload {
  attachments: AttachmentPayload[];
}

export interface AttachmentWriteBody {
  scope: AttachmentScopePayload;
}

/** What the tutor will actually retrieve from, and which level decided it.
 *  `level` is surfaced in the UI so an instructor can see *why* — an
 *  override that silently drops course readings is the failure mode this
 *  field exists to prevent. */
export interface ResolutionPayload {
  level: "section" | "homework" | "course" | "llmConfig" | "none";
  collectionIds: string[];
  documents: Array<{ id: string; path: string; indexStatus: KnowledgeIndexStatus }>;
}
