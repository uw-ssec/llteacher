const HOUR_MS = 3_600_000;

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
      .catch(() => options.error("Overdue-submission sweep failed"))
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
