/* --------------------------------------------------------------------------
   A thin Canvas REST API client (#73/#74).

   Deliberately dumb: this module never touches the database or the
   IdentityCipher. It takes a base URL and a bearer token as plain
   arguments and returns plain data or a typed error -- callers
   (repositories/organizationCredentials.ts for /validate,
   lib/services/CanvasRosterSyncService.ts for the sync) own decrypting the
   token and deciding what to do with the result. That split is what makes
   this file testable against a mocked `fetch` with zero DB setup.

   Two Canvas quirks this module hides from every caller:

     - Pagination is via the `Link` response header (rel="next"), not a
       page-number query param. `fetchAllPages` follows it until absent.
     - Rate limiting is a 403 (not 429) once `X-Rate-Limit-Remaining`
       crosses zero, with the string "Rate Limit Exceeded" in the body.
       `canvasFetch` backs off once and retries a bounded number of times
       before surfacing it as CanvasRateLimitedError.
   -------------------------------------------------------------------------- */

export class CanvasApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CanvasApiError";
  }
}

/** Thrown only after every retry in canvasFetch's own backoff is exhausted
 *  -- a caller catching this has already gotten the benefit of the doubt. */
export class CanvasRateLimitedError extends CanvasApiError {
  constructor(status: number) {
    super("Canvas rate limit exceeded; retries exhausted", status);
    this.name = "CanvasRateLimitedError";
  }
}

export interface CanvasCourseSummary {
  canvasCourseId: string;
  name: string;
  courseCode: string | null;
  term: string | null;
}

/** Canvas's own vocabulary for an enrollment's `type` field. Mapped to this
 *  app's course_role by CanvasRosterSyncService, not here -- this module
 *  stays a pure transport, with no opinion about llteacher's role model. */
export type CanvasEnrollmentType =
  | "TeacherEnrollment"
  | "TaEnrollment"
  | "StudentEnrollment"
  | "ObserverEnrollment"
  | "DesignerEnrollment"
  | (string & {});

export interface CanvasEnrollment {
  canvasEnrollmentId: string;
  type: CanvasEnrollmentType;
  enrollmentState: string;
  userId: string;
  email: string | null;
  name: string | null;
}

/** Bounds how long one Canvas call may hold up a request handler or a sync
 *  run. Canvas itself has no documented SLA; this is a defensive ceiling,
 *  not a tuned value. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1_000;
const PER_PAGE = 100;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isRateLimited(status: number, bodyText: string): boolean {
  // Canvas signals rate limiting as a 403 whose body names it explicitly,
  // not the classic 429 -- a plain 403 (a genuinely insufficient scope) must
  // not be retried as if it were transient.
  return status === 403 && bodyText.includes("Rate Limit Exceeded");
}

/** One HTTP call against the Canvas API, with the rate-limit backoff above
 *  and a hard timeout. `path` is server-relative (e.g. "/api/v1/users/self");
 *  `search` is appended as a query string. Exported so
 *  CanvasRosterSyncService's pagination loop can call it directly with a
 *  caller-supplied `next` URL (Link header values are absolute). */
export async function canvasFetch(
  url: string,
  token: string,
  options: { retriesRemaining?: number } = {},
): Promise<{ status: number; headers: Headers; bodyText: string }> {
  const retriesRemaining = options.retriesRemaining ?? MAX_RATE_LIMIT_RETRIES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const bodyText = await response.text();

  if (isRateLimited(response.status, bodyText)) {
    if (retriesRemaining <= 0) {
      throw new CanvasRateLimitedError(response.status);
    }
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
    return canvasFetch(url, token, { retriesRemaining: retriesRemaining - 1 });
  }

  return { status: response.status, headers: response.headers, bodyText };
}

/** Parses the `rel="next"` target out of a Canvas `Link` header, or null on
 *  the last page. Canvas's Link header is a comma-separated list of
 *  `<url>; rel="name"` entries -- this only ever looks for "next". */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const entry of linkHeader.split(",")) {
    const match = entry.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}

/** Follows Link-header pagination until it runs out, applying `mapItem` to
 *  every raw JSON element along the way. Fetch-then-map-then-accumulate,
 *  never fetch-and-write-per-page: every caller of this (course list,
 *  enrollment list) needs the whole collection resolved before it decides
 *  anything, and holding partial results in memory across pages is what
 *  lets a mid-pagination failure (network drop, revoked token) leave the
 *  caller's own state untouched -- see CanvasRosterSyncService's own
 *  "fetch-then-write" note for why that matters for a roster sync
 *  specifically. */
async function fetchAllPages<T>(
  firstUrl: string,
  token: string,
  mapItem: (raw: unknown) => T | null,
): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = firstUrl;
  while (url) {
    const { status, headers, bodyText } = await canvasFetch(url, token);
    if (status < 200 || status >= 300) {
      throw new CanvasApiError(
        `Canvas API request failed (${status}): ${bodyText.slice(0, 500)}`,
        status,
      );
    }
    let page: unknown;
    try {
      page = JSON.parse(bodyText);
    } catch {
      throw new CanvasApiError("Canvas API returned a non-JSON response", status);
    }
    if (!Array.isArray(page)) {
      throw new CanvasApiError("Canvas API returned an unexpected (non-array) page", status);
    }
    for (const raw of page) {
      const mapped = mapItem(raw);
      if (mapped !== null) items.push(mapped);
    }
    url = parseNextLink(headers.get("link"));
  }
  return items;
}

export type CanvasTokenValidation =
  | { ok: true; canvasUserId: string; name: string | null }
  | { ok: false; status: number; message: string };

/** #73's "Validate" button: the cheapest real call this token can make.
 *  Never throws for an ordinary auth failure (401/403) -- those are the
 *  expected "this token doesn't work" outcomes the button exists to
 *  report, distinguished from an actual transport failure (which does
 *  throw, e.g. a timeout or DNS failure against a mistyped base URL). */
export async function validateCanvasToken(
  baseUrl: string,
  token: string,
): Promise<CanvasTokenValidation> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/users/self`;
  const { status, bodyText } = await canvasFetch(url, token);
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      status,
      message:
        status === 401 || status === 403
          ? "Canvas rejected this token. Check that it hasn't expired or been revoked."
          : `Canvas returned an unexpected error (${status}).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status, message: "Canvas returned a response this app could not read." };
  }
  const body = parsed as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== "number" && typeof id !== "string") {
    return { ok: false, status, message: "Canvas returned a response this app could not read." };
  }
  return {
    ok: true,
    canvasUserId: String(id),
    name: typeof body.name === "string" ? body.name : null,
  };
}

/** #74's course picker: every course this token's own account can see.
 *  `enrollment_type=teacher` -- the token belongs to an instructor
 *  registering their own course, not a platform-wide course browser -- so
 *  the same token can't be used to enumerate every course on the Canvas
 *  instance, only the ones its owner teaches. */
export async function listCanvasCourses(
  baseUrl: string,
  token: string,
): Promise<CanvasCourseSummary[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/courses?per_page=${PER_PAGE}&enrollment_type=teacher`;
  return fetchAllPages(url, token, (raw) => {
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "number" && typeof c.id !== "string") return null;
    if (typeof c.name !== "string") return null;
    return {
      canvasCourseId: String(c.id),
      name: c.name,
      courseCode: typeof c.course_code === "string" ? c.course_code : null,
      term:
        typeof c.term === "object" && c.term !== null && typeof (c.term as Record<string, unknown>).name === "string"
          ? ((c.term as Record<string, unknown>).name as string)
          : null,
    };
  });
}

/** #74's sync source: every active/invited enrollment on one Canvas
 *  course. `state[]=active&state[]=invited` deliberately excludes
 *  `completed`/`inactive`/`rejected` -- those are people no longer (or not
 *  yet) really on the course, and the sync's removal pass (an enrollment
 *  id that WAS synced and is no longer in this list) is what retires them
 *  on the llteacher side, not a state value fetched and then filtered out
 *  here. */
export async function listCanvasEnrollments(
  baseUrl: string,
  token: string,
  canvasCourseId: string,
): Promise<CanvasEnrollment[]> {
  const url =
    `${normalizeBaseUrl(baseUrl)}/api/v1/courses/${encodeURIComponent(canvasCourseId)}/enrollments` +
    `?per_page=${PER_PAGE}&state[]=active&state[]=invited`;
  return fetchAllPages(url, token, (raw) => {
    const e = raw as Record<string, unknown>;
    const user = e.user as Record<string, unknown> | undefined;
    if (typeof e.id !== "number" && typeof e.id !== "string") return null;
    if (typeof e.type !== "string") return null;
    if (!user || (typeof user.id !== "number" && typeof user.id !== "string")) return null;
    return {
      canvasEnrollmentId: String(e.id),
      type: e.type,
      enrollmentState: typeof e.enrollment_state === "string" ? e.enrollment_state : "active",
      userId: String(user.id),
      email: typeof user.login_id === "string" ? user.login_id : typeof user.email === "string" ? user.email : null,
      name: typeof user.name === "string" ? user.name : null,
    };
  });
}
