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
  }
}

export {};
