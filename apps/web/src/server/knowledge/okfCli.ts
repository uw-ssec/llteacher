import { execFile, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export class OkfError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`okf ${args[0] ?? ""} failed (${exitCode ?? "timeout"}): ${stderr.trim().slice(0, 500)}`);
    this.name = "OkfError";
  }
}

export function okfAvailable(binary: string): boolean {
  try {
    return spawnSync(binary, ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Runs the okf binary with an argument array (never a shell string) and
 *  parses its output. By default appends --json and parses JSON. The bundle
 *  path is always one of `args`, supplied by the caller from a validated
 *  course id. The init command is text-mode (json: false) and returns the
 *  initialization message; all other commands use json: true. */
export function runOkf<T>(binary: string, args: string[], opts: { timeoutMs?: number; json?: boolean } = {}): Promise<T> {
  const useJson = opts.json !== false;
  const fullArgs = useJson ? [...args, "--json"] : args;
  return new Promise<T>((resolve, reject) => {
    execFile(
      binary,
      fullArgs,
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          reject(new OkfError(fullArgs, typeof code === "number" ? code : null, stderr || error.message));
          return;
        }
        const text = stdout.trim();
        if (!useJson) {
          resolve(text as T);
          return;
        }
        if (text === "" || text === "null") {
          resolve(null as T);
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new OkfError(fullArgs, 0, `unparseable output: ${text.slice(0, 200)}`));
        }
      },
    );
  });
}
