import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { blindIndex, encryptedText } from "../types/encrypted";

// ---------- PII handling convention ----------
// All directly identifying PII (name, email, NetID) is stored encrypted via
// `encryptedText`. Equality lookups use a sibling `blindIndex` column populated
// at write time with HMAC-SHA256 of the normalized plaintext. Range or LIKE
// queries on encrypted columns are not supported -- design admin search around
// equality on a blind index.
//
// Do not add a plaintext column for a value that would identify a student.
// Add encrypted + blind-index pair instead. See:
//   - apps/web/src/db/types/encrypted.ts (column types)
//   - apps/web/src/lib/crypto/identity-cipher.ts (encrypt/decrypt/HMAC)
//   - docs/architecture/multi-tenant-data-model.md (privacy model)

// ---------- Enums ----------

// Authoritative role vocabulary. apps/admin can't import this Drizzle
// schema across the app boundary, so packages/ui/src/auth/courseRole.ts
// hand-mirrors these values for the admin client; apps/web/src/lib/
// courseRoleParity.test.ts asserts the two stay in sync.
export const courseRoleEnum = pgEnum("course_role", [
  "instructor",
  "ta",
  "student",
  "observer",
  "admin",
]);

export const lmsProviderEnum = pgEnum("lms_provider", ["canvas"]);

export const credentialProviderEnum = pgEnum("credential_provider", [
  "openai",
  "anthropic",
  "claude_for_education",
  "openrouter",
  "local",
  "canvas",
  "workos",
]);

// ---------- Organizations ----------
// Top-level tenant. 1:1 with a WorkOS Organization (auth tenant).
// Optionally bound to a Canvas Account / sub-account (data tenant).

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    workosOrganizationId: text("workos_organization_id").notNull(),
    canvasAccountId: text("canvas_account_id"),
    requiresFerpa: boolean("requires_ferpa").notNull().default(true),
    requiresHipaa: boolean("requires_hipaa").notNull().default(false),
    dataResidency: text("data_residency"),
    allowedDomains: text("allowed_domains")
      .array()
      .notNull()
      .default(sql`ARRAY['uw.edu']::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    uniqueIndex("organizations_workos_org_uq").on(t.workosOrganizationId),
  ],
);

// ---------- Users ----------
// Global identity. workos_user_id is authoritative for non-pending users.
// Pending users are created from Canvas roster sync before first WorkOS login;
// they're reconciled by email_blind_index on first AuthKit login.
//
// PII fields (email, netid, display_name) are AES-256-GCM encrypted at rest.
// email_blind_index and netid_blind_index are HMAC-SHA256 over the normalized
// plaintext; they enable equality lookup without decryption (login
// reconciliation, "find user by netid" admin search, URL-with-netid routes).
// display_name has no blind index -- we never look users up by display name.
//
// is_active / session_epoch (issue #95): sessions are stateless sealed
// cookies with no server-side store (see lib/session.ts), so revoking one
// user's access before their 7-day cookie naturally expires needs a value
// the server can check against. session_epoch is stamped into every sealed
// cookie at login; a WorkOS deprovisioning webhook flips is_active to false
// and increments session_epoch, so every cookie issued before that moment
// stops matching (rolesMiddleware enforces the comparison via
// repositories/users.ts) while the account's PII is retained, not deleted --
// deactivation, not erasure, per #51's retention rules. A later successful
// WorkOS login is itself proof of re-authorization and clears is_active back
// to true (see UserIdentityService.createOrClaimUser) without touching
// session_epoch, so stale pre-deactivation cookies stay invalid.

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workosUserId: text("workos_user_id"),
    email: encryptedText("email").notNull(),
    emailBlindIndex: blindIndex("email_blind_index").notNull(),
    netid: encryptedText("netid"),
    netidBlindIndex: blindIndex("netid_blind_index"),
    displayName: encryptedText("display_name"),
    isPending: boolean("is_pending").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sessionEpoch: integer("session_epoch").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_blind_index_uq").on(t.emailBlindIndex),
    uniqueIndex("users_workos_user_uq")
      .on(t.workosUserId)
      .where(sql`${t.workosUserId} IS NOT NULL`),
    uniqueIndex("users_netid_blind_index_uq")
      .on(t.netidBlindIndex)
      .where(sql`${t.netidBlindIndex} IS NOT NULL`),
  ],
);

// ---------- Courses ----------
// Projection of a Canvas course, scoped to one Organization.
// last_synced_at tracks freshness of the Canvas-derived fields.

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    canvasCourseId: text("canvas_course_id"),
    code: text("code").notNull(),
    term: text("term").notNull(),
    title: text("title").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("courses_org_idx").on(t.organizationId),
    uniqueIndex("courses_org_canvas_course_uq")
      .on(t.organizationId, t.canvasCourseId)
      .where(sql`${t.canvasCourseId} IS NOT NULL`),
  ],
);

// ---------- CourseMembership ----------
// User <-> Course with a role. Replaces Django's Teacher/Student profiles.
// Projection of a Canvas enrollment when canvas_enrollment_id is present.

export const courseMemberships = pgTable(
  "course_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    role: courseRoleEnum("role").notNull(),
    canvasEnrollmentId: text("canvas_enrollment_id"),
    canvasRole: text("canvas_role"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("course_memberships_user_course_uq").on(t.userId, t.courseId),
    uniqueIndex("course_memberships_canvas_enrollment_uq")
      .on(t.canvasEnrollmentId)
      .where(sql`${t.canvasEnrollmentId} IS NOT NULL`),
    index("course_memberships_course_idx").on(t.courseId),
  ],
);

// ---------- OrganizationCredential ----------
// Per-org secrets pointer. secret_ref stores an external secrets-manager
// reference (Cloudflare Secrets Store, AWS Secrets Manager, etc.) -- never
// the secret itself.

export const organizationCredentials = pgTable(
  "organization_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: credentialProviderEnum("provider").notNull(),
    label: text("label").notNull(),
    secretRef: text("secret_ref").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("organization_credentials_org_idx").on(t.organizationId),
    uniqueIndex("organization_credentials_org_provider_label_uq").on(
      t.organizationId,
      t.provider,
      t.label,
    ),
  ],
);

// ---------- LMSIntegration ----------
// Per-course LMS connection. At most one per course in the MVP.
// LTI 1.3 deployment metadata + a pointer to the Canvas API token credential.

export const lmsIntegrations = pgTable(
  "lms_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    provider: lmsProviderEnum("provider").notNull().default("canvas"),
    ltiIss: text("lti_iss").notNull(),
    ltiClientId: text("lti_client_id").notNull(),
    ltiDeploymentId: text("lti_deployment_id").notNull(),
    apiCredentialId: uuid("api_credential_id").references(
      () => organizationCredentials.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("lms_integrations_course_uq").on(t.courseId),
    uniqueIndex("lms_integrations_iss_client_deployment_uq").on(
      t.ltiIss,
      t.ltiClientId,
      t.ltiDeploymentId,
    ),
  ],
);

// ---------- LTILaunch ----------
// Append-only log of LTI 1.3 launches. nonce uniqueness guards against replay.
// user_id is nullable + ON DELETE SET NULL so the audit trail survives a
// user deletion (FERPA "right to be forgotten" leaves the launch row, sans PII).

export const ltiLaunches = pgTable(
  "lti_launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lmsIntegrationId: uuid("lms_integration_id")
      .notNull()
      .references(() => lmsIntegrations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    nonce: text("nonce").notNull(),
    resourceLinkId: text("resource_link_id"),
    roleClaim: text("role_claim"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("lti_launches_nonce_uq").on(t.nonce),
    index("lti_launches_integration_idx").on(t.lmsIntegrationId),
    index("lti_launches_user_idx").on(t.userId),
  ],
);

// ---------- Relations ----------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  courses: many(courses),
  credentials: many(organizationCredentials),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(courseMemberships),
  ltiLaunches: many(ltiLaunches),
}));

export const coursesRelations = relations(courses, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [courses.organizationId],
    references: [organizations.id],
  }),
  memberships: many(courseMemberships),
  lmsIntegration: one(lmsIntegrations),
}));

export const courseMembershipsRelations = relations(
  courseMemberships,
  ({ one }) => ({
    user: one(users, {
      fields: [courseMemberships.userId],
      references: [users.id],
    }),
    course: one(courses, {
      fields: [courseMemberships.courseId],
      references: [courses.id],
    }),
  }),
);

export const organizationCredentialsRelations = relations(
  organizationCredentials,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [organizationCredentials.organizationId],
      references: [organizations.id],
    }),
    lmsIntegrations: many(lmsIntegrations),
  }),
);

export const lmsIntegrationsRelations = relations(
  lmsIntegrations,
  ({ one, many }) => ({
    course: one(courses, {
      fields: [lmsIntegrations.courseId],
      references: [courses.id],
    }),
    apiCredential: one(organizationCredentials, {
      fields: [lmsIntegrations.apiCredentialId],
      references: [organizationCredentials.id],
    }),
    launches: many(ltiLaunches),
  }),
);

export const ltiLaunchesRelations = relations(ltiLaunches, ({ one }) => ({
  lmsIntegration: one(lmsIntegrations, {
    fields: [ltiLaunches.lmsIntegrationId],
    references: [lmsIntegrations.id],
  }),
  user: one(users, {
    fields: [ltiLaunches.userId],
    references: [users.id],
  }),
}));
