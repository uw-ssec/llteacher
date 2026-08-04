import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { workosWebhookEvents } from "../../db/schema";
import {
  findWebhookEvent,
  recordWebhookEvent,
  purgeOldWebhookEvents,
  WEBHOOK_EVENT_RETENTION_DAYS,
} from "./webhookEvents";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("webhookEvents repository (#150, real DB)", () => {
  let db: Db;
  const ids: string[] = [];

  beforeAll(() => {
    db = makeNodeDb(DATABASE_URL!);
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.delete(workosWebhookEvents).where(eq(workosWebhookEvents.id, id));
    }
  });

  it("strips email/firstName/lastName from the stored payload, keeps safe fields", async () => {
    const id = `event_${crypto.randomUUID()}`;
    ids.push(id);
    await recordWebhookEvent(db, {
      id,
      eventType: "user.updated",
      status: "processed",
      payload: {
        object: "user",
        id: "workos_user_1",
        email: "student@uw.edu",
        firstName: "Ada",
        lastName: "Lovelace",
        profilePictureUrl: "https://example.com/photo.jpg",
        emailVerified: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    const row = await db.query.workosWebhookEvents.findFirst({
      where: eq(workosWebhookEvents.id, id),
    });

    const payload = row?.payload as Record<string, unknown>;
    expect(payload.email).toBeUndefined();
    expect(payload.firstName).toBeUndefined();
    expect(payload.lastName).toBeUndefined();
    expect(payload.profilePictureUrl).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("student@uw.edu");
    expect(JSON.stringify(payload)).not.toContain("Ada");
    expect(JSON.stringify(payload)).not.toContain("Lovelace");

    expect(payload.id).toBe("workos_user_1");
    expect(payload.object).toBe("user");
    expect(payload.emailVerified).toBe(true);
    expect(payload.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("redaction survives the onConflictDoUpdate retry path too", async () => {
    const id = `event_${crypto.randomUUID()}`;
    ids.push(id);
    await recordWebhookEvent(db, {
      id,
      eventType: "user.updated",
      status: "failed",
      payload: { id: "workos_user_2", email: "leaked@uw.edu" },
    });
    await recordWebhookEvent(db, {
      id,
      eventType: "user.updated",
      status: "processed",
      payload: { id: "workos_user_2", email: "leaked@uw.edu" },
    });

    const row = await db.query.workosWebhookEvents.findFirst({
      where: eq(workosWebhookEvents.id, id),
    });
    expect(row?.status).toBe("processed");
    expect(JSON.stringify(row?.payload)).not.toContain("leaked@uw.edu");
  });

  it("findWebhookEvent finds a recorded event by id", async () => {
    const id = `event_${crypto.randomUUID()}`;
    ids.push(id);
    await recordWebhookEvent(db, { id, eventType: "user.deleted", status: "processed", payload: {} });
    const found = await findWebhookEvent(db, id);
    expect(found?.status).toBe("processed");
  });

  it("findWebhookEvent returns undefined for an unknown id", async () => {
    const found = await findWebhookEvent(db, `event_unknown_${crypto.randomUUID()}`);
    expect(found).toBeUndefined();
  });

  it("purgeOldWebhookEvents deletes events older than the given cutoff, leaves newer ones", async () => {
    const oldId = `event_${crypto.randomUUID()}`;
    const newId = `event_${crypto.randomUUID()}`;
    await recordWebhookEvent(db, { id: oldId, eventType: "user.deleted", status: "processed", payload: {} });
    await recordWebhookEvent(db, { id: newId, eventType: "user.deleted", status: "processed", payload: {} });
    ids.push(newId); // oldId is deleted by the purge itself; newId cleaned up in afterAll

    // Backdate oldId's receivedAt directly -- recordWebhookEvent always
    // stamps "now" and has no parameter for it.
    await db
      .update(workosWebhookEvents)
      .set({ receivedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * (WEBHOOK_EVENT_RETENTION_DAYS + 1)) })
      .where(eq(workosWebhookEvents.id, oldId));

    const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * WEBHOOK_EVENT_RETENTION_DAYS);
    await purgeOldWebhookEvents(db, cutoff);

    expect(await findWebhookEvent(db, oldId)).toBeUndefined();
    expect(await findWebhookEvent(db, newId)).not.toBeUndefined();
  });
});
