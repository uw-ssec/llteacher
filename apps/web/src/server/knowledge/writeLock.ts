import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export class WriteLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for knowledge write lock at ${lockPath}`);
    this.name = "WriteLockTimeoutError";
  }
}

const POLL_MS = 25;

async function tryAcquire(lockPath: string, staleMs: number, token: string): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(token);
    } catch (err) {
      await fs.unlink(lockPath).catch(() => undefined);
      throw err;
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleMs) {
    // Steal never grants ownership; it only removes the file so the next `wx` attempt contends fairly.
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
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(lockPath, staleMs, token))) {
    if (Date.now() > deadline) throw new WriteLockTimeoutError(lockPath);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    const contents = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (contents === token) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}
