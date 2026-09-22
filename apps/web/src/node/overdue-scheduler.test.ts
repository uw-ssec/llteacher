import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOverdueScheduler } from "./overdue-scheduler";

describe("startOverdueScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at startup and once per hour", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = startOverdueScheduler({ run, error: vi.fn() });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("never overlaps runs", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = startOverdueScheduler({ run, error: vi.fn() });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(run).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish();
    await scheduler.stop();
  });

  it("logs a safe message and continues after a failed run", async () => {
    const error = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error("password=secret")).mockResolvedValue(undefined);
    const scheduler = startOverdueScheduler({ run, error });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Overdue-submission sweep failed"));
    expect(error.mock.calls.flat().join(" ")).not.toContain("password=secret");

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("stops future runs and waits for the active run", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = startOverdueScheduler({ run, error: vi.fn() });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(run).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it.each([
    ["ECONNREFUSED", " (connection_refused)"],
    ["40001", " (serialization_failure)"],
    ["password=secret", ""],
  ])("reports only allowlisted diagnostic codes: %s", async (code, suffix) => {
    const error = vi.fn();
    const scheduler = startOverdueScheduler({
      run: vi.fn().mockRejectedValue(Object.assign(new Error("password=secret"), { code })),
      error,
    });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`Overdue-submission sweep failed${suffix}`));
    expect(error.mock.calls.flat().join(" ")).not.toContain("password=secret");
    await scheduler.stop();
  });
});
