/** Shared UUID shape check for path/body params that reach a `uuid` column.
 *
 *  Extracted in the #172 audit (SEC-003): routes/homeworks.ts had defined
 *  this privately and used it only for a body field, so every UUID *path*
 *  param in the codebase reached Postgres unvalidated. A malformed value
 *  raises `invalid input syntax for type uuid`, which the generic error
 *  handler turns into a 503 "try again later" for what is a permanent
 *  client error -- a client-side bug reported as a server outage. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
