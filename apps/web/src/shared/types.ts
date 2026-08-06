import type { CourseRole } from "../server/middleware/roles";

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
   *  extend this into a general course-listing API; that's #68's job. */
  courses?: { id: string; title: string }[];
}

import type { HomeworkStatus } from "../server/repositories/homeworks";
import type { SectionStatusType, StudentHomeworkSummary } from "../server/repositories/studentHomeworks";

export type { HomeworkStatus };
export type { SectionStatusType, StudentHomeworkSummary };

export interface StudentHomeworkListResponse {
  homeworks: StudentHomeworkSummary[];
}

export interface SectionResponse {
  id: string;
  title: string;
  content: string;
  order: number;
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
  /** Present (true) only in the instructor payload; absent for students. */
  editableBy?: boolean;
}

export interface SectionDiffInput {
  id?: string;
  title: string;
  content: string;
  order: number;
  solutionContent?: string;
}

export interface HomeworkUpdateBody {
  title?: string;
  description?: string;
  dueDate?: string;
  llmConfigId?: string | null;
  sections?: SectionDiffInput[];
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
