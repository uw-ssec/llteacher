import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanvasRateLimitedError,
  listCanvasCourses,
  listCanvasEnrollments,
  validateCanvasToken,
} from "./canvas-api";

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.link) headers.set("link", init.link);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe("canvas-api", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("validateCanvasToken", () => {
    it("reports ok:true with the Canvas user id and name on a 200", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42, name: "Lauren" }));
      const result = await validateCanvasToken("https://uw.instructure.com", "tok");
      expect(result).toEqual({ ok: true, canvasUserId: "42", name: "Lauren" });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://uw.instructure.com/api/v1/users/self");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    });

    it("reports ok:false with an actionable message on a 401", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: ["not authorized"] }, { status: 401 }));
      const result = await validateCanvasToken("https://uw.instructure.com", "tok");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.message).toMatch(/revoked|expired/i);
      }
    });

    it("strips a trailing slash from the configured base URL", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
      await validateCanvasToken("https://uw.instructure.com/", "tok");
      expect(fetchMock.mock.calls[0]![0]).toBe("https://uw.instructure.com/api/v1/users/self");
    });
  });

  describe("listCanvasCourses", () => {
    it("follows Link-header pagination until the last page", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse([{ id: 1, name: "STATS 311", course_code: "STATS 311 A" }], {
            link: '<https://uw.instructure.com/api/v1/courses?page=2>; rel="next"',
          }),
        )
        .mockResolvedValueOnce(jsonResponse([{ id: 2, name: "STATS 312" }]));

      const courses = await listCanvasCourses("https://uw.instructure.com", "tok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(courses).toEqual([
        { canvasCourseId: "1", name: "STATS 311", courseCode: "STATS 311 A", term: null },
        { canvasCourseId: "2", name: "STATS 312", courseCode: null, term: null },
      ]);
    });

    it("skips a malformed row rather than failing the whole page", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1, name: "Good" }, { name: "Missing id" }]));
      const courses = await listCanvasCourses("https://uw.instructure.com", "tok");
      expect(courses).toHaveLength(1);
      expect(courses[0]!.canvasCourseId).toBe("1");
    });

    it("throws CanvasApiError on a non-2xx page", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, { status: 500 }));
      await expect(listCanvasCourses("https://uw.instructure.com", "tok")).rejects.toThrow();
    });

    // #1 (security review, PR #457): the Link header's `rel="next"` URL is
    // followed with the bearer token attached, via a fetch() this code
    // makes itself, not a browser-mediated redirect -- so nothing strips
    // the Authorization header if it points off-instance. A malicious or
    // compromised page response could otherwise hand the org-wide Canvas
    // token to any host it names.
    it("refuses to follow pagination to a different origin", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: 1, name: "STATS 311" }], {
          link: '<https://evil.example.com/steal-token>; rel="next"',
        }),
      );
      await expect(listCanvasCourses("https://uw.instructure.com", "tok")).rejects.toThrow(
        /outside the expected Canvas instance/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("listCanvasEnrollments", () => {
    it("maps enrollment rows, preferring email over login_id", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 501,
            type: "StudentEnrollment",
            enrollment_state: "active",
            user: { id: 9001, login_id: "jdoe", email: "jdoe@uw.edu", name: "Jane Doe" },
          },
        ]),
      );
      const enrollments = await listCanvasEnrollments("https://uw.instructure.com", "tok", "123");
      expect(enrollments).toEqual([
        {
          canvasEnrollmentId: "501",
          type: "StudentEnrollment",
          enrollmentState: "active",
          userId: "9001",
          email: "jdoe@uw.edu",
          name: "Jane Doe",
        },
      ]);
      expect(fetchMock.mock.calls[0]![0]).toContain("/api/v1/courses/123/enrollments");
      expect(fetchMock.mock.calls[0]![0]).toContain("state[]=active");
      expect(fetchMock.mock.calls[0]![0]).toContain("include[]=email");
    });

    it("falls back to login_id only when it's shaped like an email", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 502,
            type: "StudentEnrollment",
            enrollment_state: "active",
            user: { id: 9002, login_id: "jdoe@uw.edu", name: "Jane Doe" },
          },
        ]),
      );
      const enrollments = await listCanvasEnrollments("https://uw.instructure.com", "tok", "123");
      expect(enrollments[0]!.email).toBe("jdoe@uw.edu");
    });

    it("does not treat a bare NetID login_id as an email -- reports no email instead", async () => {
      // #12 (compatibility review, PR #457): at NetID institutions like UW,
      // login_id is a bare login name ("jdoe"), not an email. Silently
      // using it as one produces a value that fails every downstream
      // domain check instead of the clear "no email on file" a real gap
      // deserves.
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 503,
            type: "StudentEnrollment",
            enrollment_state: "active",
            user: { id: 9003, login_id: "jdoe", name: "Jane Doe" },
          },
        ]),
      );
      const enrollments = await listCanvasEnrollments("https://uw.instructure.com", "tok", "123");
      expect(enrollments[0]!.email).toBeNull();
    });

    it("skips a row with no resolvable user id", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: 1, type: "StudentEnrollment", user: {} }]),
      );
      const enrollments = await listCanvasEnrollments("https://uw.instructure.com", "tok", "123");
      expect(enrollments).toEqual([]);
    });
  });

  describe("rate limit handling", () => {
    it("retries after a 403 'Rate Limit Exceeded' response and succeeds", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("Rate Limit Exceeded", { status: 403 }))
        .mockResolvedValueOnce(jsonResponse({ id: 1, name: "OK" }));

      const promise = validateCanvasToken("https://uw.instructure.com", "tok");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true, canvasUserId: "1", name: "OK" });
    });

    it("throws CanvasRateLimitedError once retries are exhausted", async () => {
      vi.useFakeTimers();
      // A fresh Response each call: Response.text() drains the body stream,
      // so reusing one mockResolvedValue instance across retries would
      // throw "Body is unusable" on the second attempt.
      fetchMock.mockImplementation(async () => new Response("Rate Limit Exceeded", { status: 403 }));

      const promise = validateCanvasToken("https://uw.instructure.com", "tok").catch((e) => e);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeInstanceOf(CanvasRateLimitedError);
      // 1 initial attempt + 3 retries, per MAX_RATE_LIMIT_RETRIES.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not retry an ordinary 403 that isn't Canvas's rate-limit body", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
      const result = await validateCanvasToken("https://uw.instructure.com", "tok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false, status: 403, message: expect.any(String) });
    });
  });
});
