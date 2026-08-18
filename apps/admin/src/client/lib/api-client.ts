/* --------------------------------------------------------------------------
   The admin console's request layer (#33).

   Replaces `lib/fixtures.ts` as the source of every view's data. What it is
   for, beyond "wrapping fetch":

   1. ONE PLACE THAT CLASSIFIES FAILURE. Before this, each view re-derived
      "did it work" from a bare `r.ok` and collapsed every unhappy outcome
      into one sentence -- which is precisely the defect #191 filed against
      HomeworkReadOnlyView, where a deliberate 404 for unreleased content
      read as "the console is broken". `ApiError` carries the distinction so
      a view can branch on `kind` instead of on a status number it has to
      re-interpret.

   2. TYPES THAT CANNOT DRIFT. The payload shapes come from
      `@llteacher/ui/api`, which apps/web's repositories are compile-time
      checked against. The fixtures' types claimed to be "the Drizzle
      contract" in a comment; nothing enforced it.

   3. AUTH THAT IS NOT PER-CALL. Every request sends the session cookie and
      nothing else -- no token threading, no Authorization header to forget.
      A 401 is a single, central redirect rather than fifteen views each
      deciding what a logged-out user should see.

   Deliberately NOT a cache. An earlier sketch of this carried a 30s TTL Map,
   which is the wrong default for a console whose entire job is showing an
   instructor the current state of a roster they are actively editing: a
   stale read after a write is a bug report, and the request volume here is a
   handful per page view. If a listing ever gets expensive, the fix is
   server-side, not a client Map that has to be invalidated correctly from
   every mutation.
   -------------------------------------------------------------------------- */

import type {
  AddTaResultPayload,
  CourseTaPayload,
  ExportRequestBody,
  GradeDraftPayload,
  GradeListPayload,
  LlmConfigListPayload,
  LlmConfigPayload,
  LlmConfigTestPayload,
  LlmConfigWriteBody,
  RosterImportPayload,
  RosterListPayload,
} from "@llteacher/ui/api";

/** How a request failed, in the terms a view actually branches on.
 *
 *  `denied` and `missing` are separated even though both are "you cannot
 *  have this", because only one of them is worth a retry button and only one
 *  of them means the thing might come back. */
export type ApiErrorKind =
  /** 401. The session is gone. Handled centrally -- see onUnauthorized. */
  | "unauthenticated"
  /** 403. Authenticated, not permitted. Retrying cannot succeed. */
  | "denied"
  /** 404. No such thing, or not yours to see. Retrying cannot succeed. */
  | "missing"
  /** 409. A real conflict -- someone else changed it first. Reload, then retry. */
  | "conflict"
  /** 400/422. The request was wrong; `message` says how, in the server's words. */
  | "invalid"
  /** 5xx. The server failed. Retrying is reasonable. */
  | "server"
  /** No response at all -- offline, DNS, CORS. Retrying is reasonable. */
  | "network"
  /** The request exceeded its own deadline. Retrying is reasonable. */
  | "timeout"
  /** A 2xx whose body was not the shape this client expects. Deploy skew:
   *  the bundle and the Worker disagree. Reasonable to retry once the
   *  rollout finishes. */
  | "malformed";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Whether offering "Try again" is honest. A permission outcome is not
   *  retryable and a button that never works reads as a broken console --
   *  the #191 lesson, expressed once here instead of per view. */
  get retryable(): boolean {
    return this.kind === "server" || this.kind === "network" || this.kind === "timeout";
  }
}

/** Default copy per failure kind. A view can always say something better
 *  with its own nouns; this is what it gets for free. */
const DEFAULT_MESSAGE: Record<ApiErrorKind, string> = {
  unauthenticated: "Your session has ended. Sign in again to continue.",
  denied: "You do not have permission to do that.",
  missing: "That is no longer available.",
  conflict: "Someone else changed this first. Reload and try again.",
  invalid: "That request could not be processed.",
  server: "Something went wrong on our end. Please try again.",
  network: "Could not reach the server. Check your connection and try again.",
  timeout: "That request timed out.",
  malformed: "The server sent an unexpected response. Reload the console.",
};

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "denied";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "invalid";
}

/** Called once when any request 401s. Assigned by the app at startup so this
 *  module stays free of routing and of `window` at import time (which is
 *  what makes it testable in node). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RequestOptions {
  /** The caller's lifecycle signal. Required, not optional, for the reason
   *  abortAfter documents: making it optional produced two cancellation
   *  idioms for one helper, and the weaker one let abandoned requests run to
   *  completion. Pass null only where there is genuinely no lifecycle. */
  signal: AbortSignal | null;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  init: RequestInit,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    timeoutMs,
  );
  const followParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) followParent();
    else signal.addEventListener("abort", followParent, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: controller.signal,
      // The session is an HTTP-only cookie set by the Worker. Stated
      // explicitly because the admin bundle and the API are same-origin in
      // production but NOT in dev (:2312 vs :3000, via the Vite proxy), and
      // the default omits credentials on a cross-origin request.
      credentials: "same-origin",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    const name = (err as Error)?.name;
    // A lifecycle abort is not an error the caller wants reported -- it is
    // the caller's own doing. Rethrown as-is so `err.name === "AbortError"`
    // still identifies it, matching what every view already checks.
    if (name === "AbortError") throw err;
    if (name === "TimeoutError") throw new ApiError("timeout", DEFAULT_MESSAGE.timeout);
    throw new ApiError("network", DEFAULT_MESSAGE.network);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", followParent);
  }

  if (!response.ok) {
    const kind = kindForStatus(response.status);
    if (kind === "unauthenticated") onUnauthorized?.();
    // The server's own sentence when it sent one: it knows which TA is gone
    // or which field was wrong, and "please try again" would be advice that
    // never succeeds. Falls back to the generic copy for a non-JSON body,
    // which is what a proxy or gateway error page looks like.
    let message = DEFAULT_MESSAGE[kind];
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      /* non-JSON body -- keep the generic sentence */
    }
    throw new ApiError(kind, message, response.status);
  }

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("malformed", DEFAULT_MESSAGE.malformed, response.status);
  }
}

const encode = encodeURIComponent;

/** The console's API surface, grouped by the thing being acted on rather
 *  than by HTTP verb -- a view reaches for `llmConfigs.update`, not for
 *  `patch("/llm-configs/...")`. */
export const apiClient = {
  llmConfigs: {
    list: (courseId: string, opts: RequestOptions) =>
      request<LlmConfigListPayload>(
        `/api/courses/${encode(courseId)}/llm-configs`,
        { method: "GET" },
        opts,
      ),
    get: (courseId: string, configId: string, opts: RequestOptions) =>
      request<LlmConfigPayload>(
        `/api/courses/${encode(courseId)}/llm-configs/${encode(configId)}`,
        { method: "GET" },
        opts,
      ),
    create: (courseId: string, body: LlmConfigWriteBody, opts: RequestOptions) =>
      request<LlmConfigPayload>(
        `/api/courses/${encode(courseId)}/llm-configs`,
        { method: "POST", body: JSON.stringify(body) },
        opts,
      ),
    update: (
      courseId: string,
      configId: string,
      body: LlmConfigWriteBody,
      opts: RequestOptions,
    ) =>
      request<LlmConfigPayload>(
        `/api/courses/${encode(courseId)}/llm-configs/${encode(configId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
        opts,
      ),
    /** DELETE deactivates; the row survives because homeworks reference it. */
    deactivate: (courseId: string, configId: string, opts: RequestOptions) =>
      request<{ id: string; isActive: boolean }>(
        `/api/courses/${encode(courseId)}/llm-configs/${encode(configId)}`,
        { method: "DELETE" },
        opts,
      ),
    clone: (courseId: string, configId: string, name: string, opts: RequestOptions) =>
      request<LlmConfigPayload>(
        `/api/courses/${encode(courseId)}/llm-configs/${encode(configId)}/clone`,
        { method: "POST", body: JSON.stringify({ name }) },
        opts,
      ),
    /** Reaches a third-party provider, so it gets a longer deadline than the
     *  default -- the server's own bound is 25s. */
    test: (courseId: string, configId: string, message: string, opts: RequestOptions) =>
      request<LlmConfigTestPayload>(
        `/api/courses/${encode(courseId)}/llm-configs/${encode(configId)}/test`,
        { method: "POST", body: JSON.stringify({ message }) },
        { timeoutMs: 30_000, ...opts },
      ),
  },

  tas: {
    list: (courseId: string, opts: RequestOptions) =>
      request<{ tas: CourseTaPayload[] }>(
        `/api/courses/${encode(courseId)}/tas`,
        { method: "GET" },
        opts,
      ),
    add: (courseId: string, netids: string[], opts: RequestOptions) =>
      request<{ results: AddTaResultPayload[] }>(
        `/api/courses/${encode(courseId)}/tas`,
        { method: "POST", body: JSON.stringify({ netids }) },
        { timeoutMs: 30_000, ...opts },
      ),
    remove: (courseId: string, membershipId: string, opts: RequestOptions) =>
      request<{ membershipId: string }>(
        `/api/courses/${encode(courseId)}/tas/${encode(membershipId)}`,
        { method: "DELETE" },
        opts,
      ),
  },

  roster: {
    list: (courseId: string, query: { search?: string }, opts: RequestOptions) => {
      const qs = query.search ? `?search=${encode(query.search)}` : "";
      return request<RosterListPayload>(
        `/api/courses/${encode(courseId)}/roster${qs}`,
        { method: "GET" },
        opts,
      );
    },
    /** Both the preview and the commit go through one endpoint with one
     *  flag, so the rows an instructor confirms are produced by exactly the
     *  code that will write them -- a separate "validate" path would be free
     *  to disagree with the real one. */
    import: (
      courseId: string,
      body: { csv: string; preview: boolean },
      opts: RequestOptions,
    ) =>
      request<RosterImportPayload>(
        `/api/courses/${encode(courseId)}/roster/import`,
        { method: "POST", body: JSON.stringify(body) },
        { timeoutMs: 60_000, ...opts },
      ),
    remove: (courseId: string, membershipId: string, opts: RequestOptions) =>
      request<{ membershipId: string }>(
        `/api/courses/${encode(courseId)}/roster/${encode(membershipId)}`,
        { method: "DELETE" },
        opts,
      ),
  },

  grades: {
    list: (courseId: string, submissionId: string, opts: RequestOptions) =>
      request<GradeListPayload>(
        `/api/courses/${encode(courseId)}/submissions/${encode(submissionId)}/grades`,
        { method: "GET" },
        opts,
      ),
    save: (
      courseId: string,
      submissionId: string,
      body: { score: number | null; maxScore: number | null; feedback: string; supersedesGradeId?: string | null },
      opts: RequestOptions,
    ) =>
      request<GradeListPayload>(
        `/api/courses/${encode(courseId)}/submissions/${encode(submissionId)}/grades`,
        { method: "POST", body: JSON.stringify(body) },
        opts,
      ),
    /** Produces a DRAFT. It is never in force -- an instructor approves or
     *  edits it into a human grade, which is what `save` writes. */
    requestDraft: (courseId: string, submissionId: string, opts: RequestOptions) =>
      request<GradeDraftPayload>(
        `/api/courses/${encode(courseId)}/submissions/${encode(submissionId)}/grades/draft`,
        { method: "POST" },
        { timeoutMs: 45_000, ...opts },
      ),
  },

  exports: {
    /** Returns the artifact itself rather than a link. See routes/exports.ts
     *  for why this is synchronous today and what would move it to a queue. */
    create: (courseId: string, body: ExportRequestBody, opts: RequestOptions) =>
      request<{ filename: string; contentType: string; body: string }>(
        `/api/courses/${encode(courseId)}/exports`,
        { method: "POST", body: JSON.stringify(body) },
        { timeoutMs: 60_000, ...opts },
      ),
  },
};
