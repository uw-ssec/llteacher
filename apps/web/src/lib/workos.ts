import { WorkOS } from "@workos-inc/node";

let cached: WorkOS | null = null;

export function getWorkOS(apiKey: string): WorkOS {
  if (!cached) {
    cached = new WorkOS(apiKey);
  }
  return cached;
}
