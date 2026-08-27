/** User-facing message for any backend dependency failure (DB down,
 *  misconfigured secrets, etc.) -- never leaks the real error to the client. */
export const SERVICE_UNAVAILABLE_MESSAGE = "Something went wrong. Please try again later.";

/** Extra, structured fields threaded alongside a log line's own context
 *  label and message -- #275: chatHandler's failure paths (a provider error
 *  mid-stream, a turn that produced nothing, a persistence failure in
 *  onFinish) all fire from inside async callbacks with no request-scoped
 *  logger of their own to attach conversationId/userId/model automatically,
 *  so each call site passes them explicitly instead. A plain data bag, not
 *  a new logging abstraction -- there is no M8 real logging/telemetry
 *  surface yet (this issue's own note), so this stays console-based. */
export type LogContext = Record<string, unknown>;

/** Shared by logServerError/logServerWarn below so both emit the exact same
 *  JSON shape (just a different `level`/console method) instead of two
 *  independent formats drifting apart. One line per call -- greppable on
 *  `"level":"error"` or a specific `context`, and countable (`wc -l` /
 *  `jq -s length` over a log stream), which is what #275 asks for -- not
 *  "however many lines this particular Error's own stack happens to
 *  produce" the way a bare `console.error(context, err)` was. */
function emitLogLine(sink: (line: string) => void, payload: Record<string, unknown>): void {
  sink(JSON.stringify({ ...payload, time: new Date().toISOString() }));
}

/** Logs the real error server-side so it's visible in console/logs, while
 *  callers show only SERVICE_UNAVAILABLE_MESSAGE to the client.
 *
 *  #275: `extra` is optional and purely additive -- every pre-existing call
 *  site (`logServerError(context, err)`, no third argument) keeps compiling
 *  and behaving the same way, just now emitting one JSON line instead of
 *  two separate console.error arguments. A caller that DOES have
 *  request-scoped identifiers (chatHandler's stream/onFinish paths) passes
 *  them here as structured fields instead of folding them into the Error's
 *  own message string, which is what made those fields un-greppable
 *  before. */
export function logServerError(context: string, err: unknown, extra?: LogContext): void {
  emitLogLine(console.error, {
    level: "error",
    context,
    message: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    ...extra,
  });
}

/** Same shape and call site as logServerError, at warn level -- for an
 *  outcome that is not itself an exception (nothing threw) but is still
 *  worth an operator's attention. #275's own example: chatHandler's onFinish
 *  refusing to persist a turn that produced no renderable content -- "the
 *  system saying this turn produced nothing" should not be silent, but it
 *  is also not an `Error` to wrap. `detail` becomes the JSON line's own
 *  `message` field, matching logServerError's field name so both levels are
 *  greppable by the same key. */
export function logServerWarn(context: string, detail: string, extra?: LogContext): void {
  emitLogLine(console.warn, { level: "warn", context, message: detail, ...extra });
}
