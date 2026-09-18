import { closeDb, makeDb, type Db } from "../db/client";
import { loadDatabaseUrl } from "../runtime/config";
import {
  autoSubmitOverdueSections,
  type AutoSubmitRunSummary,
} from "../server/jobs/autoSubmitOverdue";

export type OverdueJobDependencies = {
  loadDatabaseUrl: typeof loadDatabaseUrl;
  makeDb: typeof makeDb;
  closeDb: typeof closeDb;
  runSweep(db: Db): Promise<AutoSubmitRunSummary>;
};

const productionDependencies: OverdueJobDependencies = {
  loadDatabaseUrl,
  makeDb,
  closeDb,
  runSweep: autoSubmitOverdueSections,
};

/** Runs one overdue-submission sweep and always releases its database pool. */
export async function runOverdueJob(
  dependencies: OverdueJobDependencies = productionDependencies,
): Promise<AutoSubmitRunSummary> {
  const databaseUrl = dependencies.loadDatabaseUrl(process.env);
  const db = dependencies.makeDb(databaseUrl);

  try {
    return await dependencies.runSweep(db);
  } finally {
    await dependencies.closeDb();
  }
}

export type OverdueJobCliDependencies = {
  run: () => Promise<AutoSubmitRunSummary>;
  info: typeof console.info;
  error: typeof console.error;
  setExitCode(code: number): void;
};

export async function runOverdueJobCli(dependencies: OverdueJobCliDependencies = {
  run: () => runOverdueJob(),
  info: console.info,
  error: console.error,
  setExitCode: (code) => { process.exitCode = code; },
}): Promise<void> {
  try {
    dependencies.info("Overdue-submission sweep complete", await dependencies.run());
  } catch (error) {
    dependencies.error("Overdue-submission sweep failed", error);
    dependencies.setExitCode(1);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  void runOverdueJobCli();
}
