import { closeDb, makeDb, type Db } from "../db/client";
import { loadRuntimeConfig } from "../runtime/config";
import {
  autoSubmitOverdueSections,
  type AutoSubmitRunSummary,
} from "../server/jobs/autoSubmitOverdue";

export type OverdueJobDependencies = {
  loadRuntimeConfig: typeof loadRuntimeConfig;
  makeDb: typeof makeDb;
  closeDb: typeof closeDb;
  runSweep(db: Db): Promise<AutoSubmitRunSummary>;
};

const productionDependencies: OverdueJobDependencies = {
  loadRuntimeConfig,
  makeDb,
  closeDb,
  runSweep: autoSubmitOverdueSections,
};

/** Runs one overdue-submission sweep and always releases its database pool. */
export async function runOverdueJob(
  dependencies: OverdueJobDependencies = productionDependencies,
): Promise<AutoSubmitRunSummary> {
  const config = dependencies.loadRuntimeConfig(process.env);
  const db = dependencies.makeDb(config.DATABASE_URL);

  try {
    return await dependencies.runSweep(db);
  } finally {
    await dependencies.closeDb();
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  void runOverdueJob().then(
    (summary) => {
      console.info("Overdue-submission sweep complete", summary);
    },
    (error: unknown) => {
      console.error("Overdue-submission sweep failed", error);
      process.exitCode = 1;
    },
  );
}
