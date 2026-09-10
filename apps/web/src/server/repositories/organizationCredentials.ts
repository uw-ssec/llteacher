/* --------------------------------------------------------------------------
   #73: the instructor-supplied Canvas API token.

   One credential per organization, at a fixed label -- unlike llm_configs'
   organization_credentials rows (which can be many, one per provider
   binding an instructor names), the console offers exactly one Canvas
   connection per org, matching the "instructor registers their token"
   flow the issue describes. CANVAS_CREDENTIAL_LABEL is that fixed label;
   `organization_credentials_org_provider_label_uq` (schema) is what makes
   "set" an upsert rather than a second row.

   The full token is never returned by anything in this module. Every read
   path here returns either a decrypted plaintext (for internal use by
   canvas-api.ts callers only -- never serialized into an HTTP response) or
   a masked summary (safe to return to the console).
   -------------------------------------------------------------------------- */

import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { organizationCredentials } from "../../db/schema";
import type { OrgScope } from "./scope";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

const PROVIDER = "canvas" as const;
export const CANVAS_CREDENTIAL_LABEL = "canvas";

export interface CanvasCredentialSummary {
  id: string;
  maskedToken: string;
  canvasBaseUrl: string;
  expiresAt: string | null;
  rotatedAt: string | null;
}

export interface DecryptedCanvasCredential {
  id: string;
  token: string;
  canvasBaseUrl: string;
}

/** First 2 + last 2 characters, per #73's requirement -- enough for an
 *  instructor to recognize which token they entered, never enough to be
 *  useful to anyone else. A token of 4 characters or fewer (never real,
 *  but not this function's job to validate) masks to dots only rather
 *  than risking an off-by-one that reveals the whole thing. */
export function maskToken(token: string): string {
  if (token.length <= 4) return "••••";
  return `${token.slice(0, 2)}••••${token.slice(-2)}`;
}

export async function getCanvasCredentialSummary(
  db: Db,
  cipher: IdentityCipher,
  orgScope: OrgScope,
): Promise<CanvasCredentialSummary | null> {
  const row = await db.query.organizationCredentials.findFirst({
    where: and(
      eq(organizationCredentials.organizationId, orgScope),
      eq(organizationCredentials.provider, PROVIDER),
      eq(organizationCredentials.label, CANVAS_CREDENTIAL_LABEL),
    ),
  });
  if (!row || !row.encryptedSecret || !row.canvasBaseUrl) return null;

  const token = await cipher.decryptString(row.encryptedSecret);
  return {
    id: row.id,
    maskedToken: maskToken(token),
    canvasBaseUrl: row.canvasBaseUrl,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  };
}

/** Internal use only (canvas-api.ts callers: /validate, the course
 *  picker, the sync service) -- never call this from a route handler that
 *  serializes its return value straight into a response. */
export async function getDecryptedCanvasCredential(
  db: Db,
  cipher: IdentityCipher,
  orgScope: OrgScope,
): Promise<DecryptedCanvasCredential | null> {
  const row = await db.query.organizationCredentials.findFirst({
    where: and(
      eq(organizationCredentials.organizationId, orgScope),
      eq(organizationCredentials.provider, PROVIDER),
      eq(organizationCredentials.label, CANVAS_CREDENTIAL_LABEL),
    ),
  });
  if (!row || !row.encryptedSecret || !row.canvasBaseUrl) return null;

  return {
    id: row.id,
    token: await cipher.decryptString(row.encryptedSecret),
    canvasBaseUrl: row.canvasBaseUrl,
  };
}

/** Creates the org's Canvas credential, or replaces it if one already
 *  exists -- "Replace token" (#73) is a full re-entry, not a diff, so this
 *  is one upsert rather than a separate create/update pair. rotatedAt is
 *  stamped on every call, including the first, so "when was this last
 *  entered" is answerable identically for a first save and a rotation. */
export async function setCanvasCredential(
  db: Db,
  cipher: IdentityCipher,
  orgScope: OrgScope,
  input: { token: string; canvasBaseUrl: string; expiresAt: Date | null },
): Promise<{ id: string }> {
  const encryptedSecret = await cipher.encryptString(input.token);
  const now = new Date();
  const [row] = await db
    .insert(organizationCredentials)
    .values({
      organizationId: orgScope,
      provider: PROVIDER,
      label: CANVAS_CREDENTIAL_LABEL,
      encryptedSecret,
      canvasBaseUrl: input.canvasBaseUrl,
      expiresAt: input.expiresAt,
      rotatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        organizationCredentials.organizationId,
        organizationCredentials.provider,
        organizationCredentials.label,
      ],
      set: {
        encryptedSecret,
        canvasBaseUrl: input.canvasBaseUrl,
        expiresAt: input.expiresAt,
        rotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: organizationCredentials.id });
  return { id: row!.id };
}

/** Real delete, not a soft drop: a credential is a secret, not an
 *  education record -- nothing needs it to survive for FERPA/audit
 *  replay the way a course_memberships row does. Any lms_integrations row
 *  pointing at it falls back to null (ON DELETE SET NULL) rather than
 *  cascading, so a course link survives losing its credential and the
 *  console can say "this course's Canvas connection needs a token"
 *  instead of the link itself vanishing. */
export async function deleteCanvasCredential(
  db: Db,
  orgScope: OrgScope,
): Promise<{ deleted: boolean; id?: string }> {
  const [deleted] = await db
    .delete(organizationCredentials)
    .where(
      and(
        eq(organizationCredentials.organizationId, orgScope),
        eq(organizationCredentials.provider, PROVIDER),
        eq(organizationCredentials.label, CANVAS_CREDENTIAL_LABEL),
      ),
    )
    .returning({ id: organizationCredentials.id });
  return deleted ? { deleted: true, id: deleted.id } : { deleted: false };
}
