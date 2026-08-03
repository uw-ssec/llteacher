/** User-facing message for any backend dependency failure (DB down,
 *  misconfigured secrets, etc.) -- never leaks the real error to the client. */
export const SERVICE_UNAVAILABLE_MESSAGE = "Something went wrong. Please try again later.";

/** Logs the real error server-side so it's visible in console/logs, while
 *  callers show only SERVICE_UNAVAILABLE_MESSAGE to the client. */
export function logServerError(context: string, err: unknown): void {
  console.error(`[${context}]`, err);
}
