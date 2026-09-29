import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

const migrateMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: migrateMock }));

import { applyMigrationsFolder } from "./migrate";

function buildMigrationsFolder(statement: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "llteacher-migrate-unit-"));
  fs.mkdirSync(path.join(folder, "meta"));
  fs.writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1,
          tag: "0000_test_concurrent_index",
          breakpoints: true,
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(folder, "0000_test_concurrent_index.sql"), statement);
  return folder;
}

describe("applyMigrationsFolder concurrent-index preflight", () => {
  const folders: string[] = [];

  afterEach(() => {
    migrateMock.mockClear();
    for (const folder of folders.splice(0)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each([
    "CREATE INDEX CONCURRENTLY conversations_test_idx ON conversations (id);",
    "CREATE UNIQUE INDEX CONCURRENTLY conversations_test_idx ON conversations (id);",
  ])("rejects %s without running a migration", async (statement) => {
    const folder = buildMigrationsFolder(statement);
    folders.push(folder);
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const db = {} as NodePgDatabase;

    await expect(applyMigrationsFolder(pool, db, folder)).rejects.toThrow(
      /0000_test_concurrent_index\.sql.*IF NOT EXISTS/i,
    );
    expect(migrateMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("runs a valid UNIQUE concurrent index outside the transactional migrator", async () => {
    const statement =
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversations_test_idx ON conversations (id);";
    const folder = buildMigrationsFolder(statement);
    folders.push(folder);
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const db = {} as NodePgDatabase;

    await expect(applyMigrationsFolder(pool, db, folder)).resolves.toBeUndefined();

    expect(migrateMock).toHaveBeenCalledOnce();
    expect(migrateMock.mock.calls[0]?.[1]).not.toEqual({ migrationsFolder: folder });
    expect(pool.query).toHaveBeenNthCalledWith(2, statement);
  });
});
