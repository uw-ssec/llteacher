/* --------------------------------------------------------------------------
   End to end: the real Node server, a real Postgres, real HTTP.

   Black-box on purpose. Each server under test is `src/node/server.ts` in
   its own child process -- the same entry point `npm run node:serve` and
   the container run -- on its own port, configured only through its
   environment. Nothing in the request path is mocked: sessions are sealed
   with the server's SESSION_SECRET, rows are written to a database created
   and migrated for this run, and failures are produced by breaking that
   database for real, not by stubbing a repository:

   - an unreachable Postgres (a server pointed at a closed port) must answer
     503 and log a DatabaseError classified `unavailable`;
   - a broken query (a table renamed underneath a running server) must
     answer 503, log a DatabaseError classified `query` naming the exact
     repository operation, and recover once the table is back;
   - a server started with missing configuration must refuse to start and
     name every missing variable at once.

   The database is a fresh one per run (CREATE DATABASE + the real migration
   runner), so renaming a table cannot disturb any other suite sharing
   DATABASE_URL. Skipped without DATABASE_URL, like every DB-backed suite.
   -------------------------------------------------------------------------- */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { createSessionPayload, loadSessionKey, sealSession, SESSION_COOKIE_NAME } from "../../lib/session";

const DATABASE_URL = process.env.DATABASE_URL;
const WEB_ROOT = resolve(import.meta.dirname, "../../..");
const TSX = resolve(WEB_ROOT, "../../node_modules/.bin/tsx");
const NS = randomUUID().slice(0, 8);
const E2E_DB = `llteacher_e2e_${NS}`;

const key = () => randomBytes(32).toString("base64");
const SECRETS = { SESSION_SECRET: key(), ENCRYPTION_KEY: key(), BLIND_INDEX_KEY: key() };

/** Everything the server requires, pointed at nothing real outside this
 *  machine. LLMOXIE_BASE_URL is set so the gateway can never fall back to
 *  the production default. */
function serverEnv(databaseUrl: string, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
    DATABASE_URL: databaseUrl,
    WORKOS_API_KEY: "sk_test_e2e",
    WORKOS_CLIENT_ID: "client_e2e",
    WORKOS_WEBHOOK_SECRET: "whsec_e2e",
    LLMOXIE_API_KEY: "llmoxie-e2e",
    LLMOXIE_BASE_URL: "http://127.0.0.1:9/unused",
    ...SECRETS,
  };
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

type RunningServer = { base: string; child: ChildProcess; stderr: () => string };

async function startServer(databaseUrl: string): Promise<RunningServer> {
  const port = await freePort();
  const child = spawn(TSX, ["src/node/server.ts"], { cwd: WEB_ROOT, env: serverEnv(databaseUrl, port) });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, child, stderr: () => stderr };
}

async function stopServer(server: RunningServer | undefined) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((r) => server.child.once("exit", r));
  server.child.kill("SIGTERM");
  await exited;
}

/** The JSON log lines a server wrote to stderr since `offset`. */
function logLines(server: RunningServer, offset = 0): Array<Record<string, unknown>> {
  return server.stderr().slice(offset).split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return typeof parsed === "object" && parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/** Polls briefly for a log line: stderr is a pipe, so a line can trail the
 *  response that caused it. */
async function waitForLog(server: RunningServer, offset: number, match: Record<string, unknown>) {
  for (let i = 0; i < 50; i++) {
    const hit = logLines(server, offset).find((line) => Object.entries(match).every(([k, v]) => line[k] === v));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no log line matching ${JSON.stringify(match)} in:\n${server.stderr().slice(offset)}`);
}

describe.skipIf(!DATABASE_URL)("Effect request pipeline, end to end", () => {
  let admin: Pool;
  let e2eUrl: string;
  let e2ePool: Pool;
  let server: RunningServer;
  let downServer: RunningServer | undefined;

  const ids = {} as {
    course: string;
    otherCourse: string;
    section: string;
    nonInteractiveSection: string;
    otherCourseSection: string;
  };
  const cookies = {} as { student: string; outsider: string; revoked: string };

  const api = (path: string, init: RequestInit & { as?: keyof typeof cookies } = {}) => {
    const headers = new Headers(init.headers);
    if (init.as) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookies[init.as]}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${server.base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE DATABASE ${E2E_DB}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${E2E_DB}`;
    e2eUrl = url.toString();
    e2ePool = new Pool({ connectionString: e2eUrl });
    await e2ePool.query("CREATE EXTENSION IF NOT EXISTS vector");
    execFileSync(TSX, ["scripts/migrate.ts"], {
      cwd: WEB_ROOT,
      env: { ...process.env, DATABASE_URL: e2eUrl },
      stdio: "pipe",
    });

    // Seeds through the same pool afterAll closes, so DROP DATABASE ... FORCE
    // never terminates a connection something still listens on.
    const db = drizzle(e2ePool, { schema });
    const cipher = new IdentityCipher(await loadIdentityCipherKeys(SECRETS as unknown as Env));
    const [org] = await db.insert(schema.organizations)
      .values({ slug: `e2e-${NS}`, name: "E2E University", workosOrganizationId: `org_e2e_${NS}` })
      .returning();
    const [course, otherCourse] = await db.insert(schema.courses).values([
      { organizationId: org!.id, code: "E2E 101", term: "Fall 2026", title: "Typed Errors" },
      { organizationId: org!.id, code: "E2E 202", term: "Fall 2026", title: "Someone Else's Course" },
    ]).returning();

    const makeUser = async (handle: string) => {
      const email = `${handle}-${NS}@example.com`;
      const [user] = await db.insert(schema.users).values({
        email: await cipher.encryptString(email),
        emailBlindIndex: await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
        displayName: await cipher.encryptString(handle),
        workosUserId: `user_${handle}_${NS}`,
        isPending: false,
      }).returning();
      return user!;
    };
    const instructor = await makeUser("instructor");
    const student = await makeUser("student");
    const outsider = await makeUser("outsider");
    const [instructorMembership] = await db.insert(schema.courseMemberships).values([
      { userId: instructor.id, courseId: course!.id, role: "instructor" },
      { userId: student.id, courseId: course!.id, role: "student" },
      { userId: outsider.id, courseId: otherCourse!.id, role: "student" },
      { userId: instructor.id, courseId: otherCourse!.id, role: "instructor" },
    ]).returning();

    const homework = async (courseId: string) => {
      const [hw] = await db.insert(schema.homeworks).values({
        courseId,
        createdById: instructorMembership!.id,
        title: "Effect basics",
        description: "Typed failures.",
        dueDate: new Date(Date.now() + 7 * 86_400_000),
        publishedAt: new Date(),
      }).returning();
      return hw!.id;
    };
    const homeworkId = await homework(course!.id);
    const [section, nonInteractive] = await db.insert(schema.sections).values([
      { homeworkId, order: 1, title: "Tagged errors", content: "# What is a tagged error?" },
      { homeworkId, order: 2, title: "Reading", content: "Read the chapter.", type: "non_interactive" },
    ]).returning();
    const [otherSection] = await db.insert(schema.sections)
      .values({ homeworkId: await homework(otherCourse!.id), order: 1, title: "Elsewhere", content: "x" })
      .returning();

    Object.assign(ids, {
      course: course!.id,
      otherCourse: otherCourse!.id,
      section: section!.id,
      nonInteractiveSection: nonInteractive!.id,
      otherCourseSection: otherSection!.id,
    });

    const sessionKey = await loadSessionKey(SECRETS as unknown as Env);
    cookies.student = await sealSession(createSessionPayload(student.id, student.workosUserId!, student.sessionEpoch), sessionKey);
    cookies.outsider = await sealSession(createSessionPayload(outsider.id, outsider.workosUserId!, outsider.sessionEpoch), sessionKey);
    // A cookie minted before a deprovisioning webhook bumped the epoch (#95).
    cookies.revoked = await sealSession(createSessionPayload(student.id, student.workosUserId!, student.sessionEpoch - 1), sessionKey);

    server = await startServer(e2eUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    await stopServer(downServer);
    await e2ePool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await admin?.end();
  }, 60_000);

  const startPath = (courseId: string, sectionId: string) => `/api/courses/${courseId}/sections/${sectionId}/conversations`;

  it("401 Unauthorized: no session cookie", async () => {
    const res = await api(startPath(ids.course, ids.section), { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401 Unauthorized: a validly sealed but revoked session", async () => {
    const res = await api(startPath(ids.course, ids.section), { method: "POST", as: "revoked" });
    expect(res.status).toBe(401);
  });

  it("403 Forbidden: a member of a different course", async () => {
    const res = await api(startPath(ids.course, ids.section), { method: "POST", as: "outsider" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Course access denied" });
  });

  it("404 NotFound: a malformed id and a section outside the course answer identically", async () => {
    const malformed = await api(startPath(ids.course, "not-a-uuid"), { method: "POST", as: "student" });
    const elsewhere = await api(startPath(ids.course, ids.otherCourseSection), { method: "POST", as: "student" });
    expect([malformed.status, elsewhere.status]).toEqual([404, 404]);
    expect(await malformed.json()).toEqual({ error: "Section not found" });
    expect(await elsewhere.json()).toEqual({ error: "Section not found" });
  });

  it("409 Conflict: a non-interactive section never holds a conversation", async () => {
    const res = await api(startPath(ids.course, ids.nonInteractiveSection), { method: "POST", as: "student" });
    expect(res.status).toBe(409);
  });

  it("201 then 409 Conflict: starting the same section twice", async () => {
    const first = await api(startPath(ids.course, ids.section), { method: "POST", as: "student" });
    expect(first.status).toBe(201);
    const second = await api(startPath(ids.course, ids.section), { method: "POST", as: "student" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "An active conversation already exists for this section" });
  });

  it("200: the active conversation reads back with its greeting", async () => {
    const res = await api(`/api/courses/${ids.course}/sections/${ids.section}/conversation`, { as: "student" });
    expect(res.status).toBe(200);
    const body = await res.json() as { conversation: { id: string }; messages: unknown[] };
    expect(body.conversation.id).toMatch(/[0-9a-f-]{36}/);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("400 BadRequest: an out-of-range page size", async () => {
    const res = await api(`/api/courses/${ids.course}/sections/${ids.section}/conversation?limit=9999`, { as: "student" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "limit must be an integer between 1 and 500" });
  });

  it("404 NotFound: restarting a conversation that does not exist", async () => {
    const res = await api(`/api/courses/${ids.course}/conversations/${randomUUID()}/restart`, { method: "POST", as: "student" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  it("503 DatabaseError(query): a broken query names its operation, hides the cause, and recovers", async () => {
    const path = `/api/courses/${ids.course}/sections/${ids.section}/conversation`;
    const offset = server.stderr().length;
    await e2ePool.query("ALTER TABLE messages RENAME TO messages_e2e_broken");
    try {
      const res = await api(path, { as: "student" });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "Something went wrong. Please try again later." });
      expect(JSON.stringify(body)).not.toMatch(/messages|relation|postgres/i);

      const line = await waitForLog(server, offset, { tag: "DatabaseError", reason: "query" });
      expect(line).toMatchObject({
        level: "error",
        context: "server",
        method: "GET",
        path,
        operation: "getSectionConversationMessages",
      });
      expect(String(line.message)).toMatch(/messages/);
    } finally {
      await e2ePool.query("ALTER TABLE messages_e2e_broken RENAME TO messages");
    }
    expect((await api(path, { as: "student" })).status).toBe(200);
  });

  it("503 DatabaseError(unavailable): Postgres unreachable, classified in the auth path", async () => {
    downServer = await startServer("postgres://llteacher@127.0.0.1:1/unreachable");
    const offset = downServer.stderr().length;
    const res = await fetch(`${downServer.base}${startPath(ids.course, ids.section)}`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookies.student}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Something went wrong. Please try again later." });
    const line = await waitForLog(downServer, offset, { tag: "DatabaseError", reason: "unavailable" });
    expect(["listMembershipsForUser", "getUserActivationState"]).toContain(line.operation);
    // The health check needs no database, so the process itself is up.
    expect((await fetch(`${downServer.base}/api/health`)).status).toBe(200);
  }, 90_000);

  it("RuntimeConfigError: a server missing configuration refuses to start and names every problem", async () => {
    const env = serverEnv(e2eUrl, await freePort());
    delete env.SESSION_SECRET;
    delete env.WORKOS_API_KEY;
    const child = spawn(TSX, ["src/node/server.ts"], { cwd: WEB_ROOT, env });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).not.toBe(0);
    expect(stderr).toContain("WORKOS_API_KEY is required; SESSION_SECRET is required");
  }, 60_000);
});
