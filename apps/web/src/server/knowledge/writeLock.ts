import { promises as fs } from "node:fs";

export class WriteLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for knowledge write lock at ${lockPath}`);
    this.name = "WriteLockTimeoutError";
  }
}

const POLL_MS = 25;

async function tryAcquire(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleMs) {
    await fs.unlink(lockPath).catch(() => undefined);
  }
  return false;
}

/** O_EXCL lock file. One instructor per course and one ECS task make
 *  contention rare; this exists so two console requests from the same
 *  instructor cannot interleave okf's index regeneration. */
export async function withWriteLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(lockPath, staleMs))) {
    if (Date.now() > deadline) throw new WriteLockTimeoutError(lockPath);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}
