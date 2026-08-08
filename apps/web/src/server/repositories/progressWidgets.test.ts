import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, homeworks, homeworkProgressWidgets, courseMemberships } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import { planWidgetDiff, submitWidgetResponse, type ExistingWidget } from "./progressWidgets";

const existing: ExistingWidget[] = [
  { id: "w1", order: 1, prePrompt: "How confident before?", postPrompt: "How confident after?" },
  { id: "w2", order: 2, prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after" },
];

describe("planWidgetDiff", () => {
  it("creates widgets with no id", () => {
    const plan = planWidgetDiff([], [{ prePrompt: "pre", postPrompt: "post", order: 1 }]);
    expect(plan.toCreate).toEqual([{ prePrompt: "pre", postPrompt: "post", order: 1 }]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("updates a widget whose id matches an existing row (prompt/order change)", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before? (revised)", postPrompt: "How confident after?", order: 1 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 2 },
    ]);
    expect(plan.toUpdate).toEqual([
      { id: "w1", prePrompt: "How confident before? (revised)", postPrompt: "How confident after?", order: 1 },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("omits unchanged widgets from toUpdate", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 1 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 2 },
    ]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("deletes existing widgets omitted from the incoming array", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 1 },
    ]);
    expect(plan.toDelete).toEqual([{ id: "w2" }]);
  });

  it("reorders by keeping id but changing order", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 2 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 1 },
    ]);
    expect(plan.toUpdate.map((u) => ({ id: u.id, order: u.order }))).toEqual([
      { id: "w1", order: 2 },
      { id: "w2", order: 1 },
    ]);
  });

  it("throws when two incoming widgets share the same order", () => {
    expect(() =>
      planWidgetDiff([], [
        { prePrompt: "a", postPrompt: "a", order: 1 },
        { prePrompt: "b", postPrompt: "b", order: 1 },
      ]),
    ).toThrow(/duplicate order/i);
  });

  it("throws when an incoming widget references an id not in existing", () => {
    expect(() =>
      planWidgetDiff(existing, [{ id: "does-not-exist", prePrompt: "x", postPrompt: "x", order: 1 }]),
    ).toThrow(/unknown widget id/i);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("submitWidgetResponse (real DB)", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let membershipAId: string;
  let studentId: string;
  let unenrolledStudentId: string;
  let droppedStudentId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `pw-repo-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `pw-repo-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB.id;
    const [courseA] = await db
      .insert(courses)
      .values({ organizationId: orgAId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseAId = courseA.id;
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [userA] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    const [membershipA] = await db
      .insert(courseMemberships)
      .values({ userId: userA.id, courseId: courseAId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipAId = membershipA.id;

    // #175: the student who actually writes -- distinct from the instructor
    // creator above (course memberships are unique per (userId, courseId)).
    const studentEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [studentUser] = await db
      .insert(users)
      .values({ email: studentEmailBytes as never, emailBlindIndex: studentEmailBytes as never })
      .returning({ id: users.id });
    studentId = studentUser.id;
    await db.insert(courseMemberships).values({ userId: studentId, courseId: courseAId, role: "student" });

    const unenrolledEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [unenrolledUser] = await db
      .insert(users)
      .values({ email: unenrolledEmailBytes as never, emailBlindIndex: unenrolledEmailBytes as never })
      .returning({ id: users.id });
    unenrolledStudentId = unenrolledUser.id;

    const droppedEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [droppedUser] = await db
      .insert(users)
      .values({ email: droppedEmailBytes as never, emailBlindIndex: droppedEmailBytes as never })
      .returning({ id: users.id });
    droppedStudentId = droppedUser.id;
    await db.insert(courseMemberships).values({ userId: droppedStudentId, courseId: courseAId, role: "student", droppedAt: new Date() });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  async function newWidget(opts: { isHidden?: boolean; expiresAt?: Date | null } = {}) {
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId: courseAId,
        createdById: membershipAId,
        title: "h",
        description: "d",
        dueDate: new Date(),
        isHidden: opts.isHidden ?? false,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning({ id: homeworks.id });
    const [widget] = await db
      .insert(homeworkProgressWidgets)
      .values({ homeworkId: hw.id, order: 1, prePrompt: "pre?", postPrompt: "post?" })
      .returning({ id: homeworkProgressWidgets.id });
    return widget.id;
  }

  it("first pre submit creates a row with postValue still null", async () => {
    const widgetId = await newWidget();
    const response = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 7 });
    expect(response.preValue).toBe(7);
    expect(response.postValue).toBeNull();
    expect(response.preSubmittedAt).not.toBeNull();
  });

  // #176: organizationId must be written on insert, not left to a default.
  it("writes organizationId from the verified scope", async () => {
    const widgetId = await newWidget();
    const response = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 7 });
    expect(response.organizationId).toBe(orgAId);
  });

  it("a later post submit updates the same row, setting postValue without touching the already-set preValue", async () => {
    const widgetId = await newWidget();
    const pre = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 4 });
    const post = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "post", value: 9 });
    expect(post.id).toBe(pre.id);
    expect(post.preValue).toBe(4);
    expect(post.postValue).toBe(9);
  });

  it("resubmitting the same which updates in place, not a new row", async () => {
    const widgetId = await newWidget();
    const first = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 3 });
    const second = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 8 });
    expect(second.id).toBe(first.id);
    expect(second.preValue).toBe(8);
  });

  it("throws when the widget belongs to a different org's course", async () => {
    const widgetId = await newWidget();
    await expect(
      submitWidgetResponse(db, unsafeOrgScope(orgBId), widgetId, studentId, { which: "pre", value: 5 }),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  // #175: no membership in the widget's course at all.
  it("throws when the calling user has no membership in the widget's course", async () => {
    const widgetId = await newWidget();
    await expect(
      submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, unenrolledStudentId, { which: "pre", value: 5 }),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  // #175: dropped enrollment must not still count.
  it("throws when the calling user's membership in the widget's course has been dropped", async () => {
    const widgetId = await newWidget();
    await expect(
      submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, droppedStudentId, { which: "pre", value: 5 }),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  // #177: manually hidden and expired homeworks both block the write.
  it("throws when the parent homework is manually hidden", async () => {
    const widgetId = await newWidget({ isHidden: true });
    await expect(
      submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 5 }),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  it("throws when the parent homework's expiresAt has passed", async () => {
    const widgetId = await newWidget({ expiresAt: new Date(Date.now() - 60_000) });
    await expect(
      submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 5 }),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  it("does not block a write when expiresAt is in the future", async () => {
    const widgetId = await newWidget({ expiresAt: new Date(Date.now() + 60_000) });
    const response = await submitWidgetResponse(db, unsafeOrgScope(orgAId), widgetId, studentId, { which: "pre", value: 5 });
    expect(response.preValue).toBe(5);
  });
});
