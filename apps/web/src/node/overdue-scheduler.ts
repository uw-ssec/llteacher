const HOUR_MS = 3_600_000;

// Never log database messages, query parameters, or arbitrary error codes:
// those may contain credentials or student data. Known categories aid triage.
function diagnosticCategory(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "ECONNREFUSED": return " (connection_refused)";
    case "ECONNRESET": return " (connection_reset)";
    case "ETIMEDOUT": return " (connection_timeout)";
    case "40001": return " (serialization_failure)";
    case "40P01": return " (deadlock)";
    case "53300": return " (database_connection_limit)";
    case "57P01": return " (database_shutdown)";
    default: return "";
  }
}

export type OverdueSchedulerOptions = {
  run(): Promise<unknown>;
  error(message: string): void;
};

export type OverdueScheduler = {
  stop(): Promise<void>;
};

/** Runs an immediate overdue sweep and then coalesces hourly ticks. */
export function startOverdueScheduler(options: OverdueSchedulerOptions): OverdueScheduler {
  let stopped = false;
  let pending = false;
  let active: Promise<void> | undefined;

  const run = () => {
    if (stopped) return;
    if (active) {
      pending = true;
      return;
    }
    active = options.run()
      .catch((error: unknown) => options.error(`Overdue-submission sweep failed${diagnosticCategory(error)}`))
      .then(() => undefined)
      .finally(() => {
        active = undefined;
        if (pending && !stopped) {
          pending = false;
          run();
        }
      });
  };

  run();
  const interval = setInterval(run, HOUR_MS);
  interval.unref();

  return {
    async stop() {
      stopped = true;
      pending = false;
      clearInterval(interval);
      await active;
    },
  };
}
