import { describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import type { AutoSubmitRunSummary } from "../server/jobs/autoSubmitOverdue";
import { type OverdueJobDependencies, runOverdueJob } from "./run-overdue-job";

const config = { DATABASE_URL: "postgres://llteacher:password@localhost:5432/llteacher" } as Env;
const summary: AutoSubmitRunSummary = {
  candidates: 0,
  submitted: 0,
  skipped: 0,
  failed: 0,
  orgsFailed: 0,
  orgsDeferred: 0,
};

describe("runOverdueJob", () => {
  it("runs the overdue sweep once and releases the database pool", async () => {
    const events: string[] = [];
    const db = {} as Db;
    const dependencies: OverdueJobDependencies = {
      loadRuntimeConfig: () => {
        events.push("load config");
        return config;
      },
      makeDb: (databaseUrl) => {
        events.push(`make db ${databaseUrl}`);
        return db;
      },
      runSweep: async (actualDb) => {
        expect(actualDb).toBe(db);
        events.push("run sweep");
        return summary;
      },
      closeDb: async () => {
        events.push("close db");
      },
    };

    await expect(runOverdueJob(dependencies)).resolves.toEqual(summary);

    expect(events).toEqual([
      "load config",
      "make db postgres://llteacher:password@localhost:5432/llteacher",
      "run sweep",
      "close db",
    ]);
  });

  it("releases the database pool when the overdue sweep fails", async () => {
    const events: string[] = [];
    const db = {} as Db;
    const dependencies: OverdueJobDependencies = {
      loadRuntimeConfig: () => config,
      makeDb: () => db,
      runSweep: async () => {
        events.push("run sweep");
        throw new Error("database unavailable");
      },
      closeDb: async () => {
        events.push("close db");
      },
    };

    await expect(runOverdueJob(dependencies)).rejects.toThrow("database unavailable");

    expect(events).toEqual(["run sweep", "close db"]);
  });
});
