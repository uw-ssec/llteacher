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
}

import type { HomeworkStatus } from "../server/repositories/homeworks";

export type { HomeworkStatus };

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
}

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
