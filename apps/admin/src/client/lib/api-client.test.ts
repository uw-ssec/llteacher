/* --------------------------------------------------------------------------
   #33: the request layer.

   What matters here is the CLASSIFICATION, not the fetch. Every view used to
   re-derive "did it work" from a bare `r.ok`, which is how a deliberate 404
   for unreleased content came to read as "the console is broken" (#191).
   These pin the distinctions a view branches on.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { apiClient, ApiError, setUnauthorizedHandler } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

const opts = { signal: null };

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("failure classification (#33)", () => {
  const cases: [number, string, boolean][] = [
    // status, kind, retryable
    [401, "unauthenticated", false],
    [403, "denied", false],
    [404, "missing", false],
    [409, "conflict", false],
    [400, "invalid", false],
    [500, "server", true],
    [503, "server", true],
  ];

  for (const [status, kind, retryable] of cases) {
    it(`maps ${status} to ${kind}`, async () => {
      stub(() => json({ error: "nope" }, status));
      const err = await apiClient.llmConfigs.list("c1", opts).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.kind).toBe(kind);
      // Offering "Try again" on an outcome that cannot change is the defect
      // #191 filed; the answer lives here once rather than per view.
      expect(err.retryable).toBe(retryable);
    });
  }

  it("prefers the server's own sentence over the generic one", async () => {
    // The server knows which TA is gone or which field was wrong; "please
    // try again" would be advice that never succeeds (#172 audit, USE-003).
    stub(() => json({ error: "That teaching assistant is no longer in this course." }, 404));
    const err = await apiClient.tas.remove("c1", "m1", opts).catch((e) => e);
    expect(err.message).toBe("That teaching assistant is no longer in this course.");
  });

  it("falls back to generic copy when the body is not JSON", async () => {
    // What a proxy or gateway error page looks like.
    stub(() => new Response("<html>502</html>", { status: 502 }));
    const err = await apiClient.llmConfigs.list("c1", opts).catch((e) => e);
    expect(err.kind).toBe("server");
    expect(err.message).toMatch(/something went wrong/i);
  });

  it("reports a 2xx with an unreadable body as deploy skew, not success", async () => {
    stub(() => new Response("not json", { status: 200 }));
    const err = await apiClient.llmConfigs.list("c1", opts).catch((e) => e);
    expect(err.kind).toBe("malformed");
  });

  it("classifies a dead network separately from a server fault", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await apiClient.llmConfigs.list("c1", opts).catch((e) => e);
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });
});

describe("session handling (#33)", () => {
  it("calls the unauthorized handler exactly once on a 401", async () => {
    // One central redirect rather than fifteen views each deciding what a
    // logged-out user should see.
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    stub(() => json({ error: "no session" }, 401));
    await apiClient.llmConfigs.list("c1", opts).catch(() => {});
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it("does not fire it for a 403", async () => {
    // Authenticated and refused is not the same as signed out; redirecting
    // would throw away the instructor's place for no reason.
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    stub(() => json({ error: "denied" }, 403));
    await apiClient.llmConfigs.list("c1", opts).catch(() => {});
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it("sends the session cookie on every request", async () => {
    const mock = stub(() => json({ configs: [] }));
    await apiClient.llmConfigs.list("c1", opts);
    // Same-origin in production, cross-origin via the Vite proxy in dev --
    // where the default would omit credentials entirely.
    expect(mock.mock.calls[0]![1]!.credentials).toBe("same-origin");
  });
});

describe("cancellation (#33)", () => {
  it("rethrows a lifecycle abort as-is so callers can recognise it", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => rej(init.signal!.reason));
          }),
      ),
    );
    const pending = apiClient.llmConfigs.list("c1", { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await pending;
    // Not an ApiError: every view already checks `err.name === "AbortError"`
    // to avoid flashing a failure on the way out.
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("turns its own deadline into a retryable timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => rej(init.signal!.reason));
          }),
      ),
    );
    const pending = apiClient.llmConfigs.list("c1", opts).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("gives provider-reaching calls a longer deadline than a plain read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => rej(init.signal!.reason));
          }),
      ),
    );
    const pending = apiClient.llmConfigs.test("c1", "cfg", "hi", opts).catch((e) => e);
    // The server's own bound on a test-send is 25s; timing out at 15 would
    // report a failure for a request still legitimately in flight.
    await vi.advanceTimersByTimeAsync(20_000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    expect((await pending).kind).toBe("timeout");
  });
});

describe("request shapes (#33)", () => {
  it("encodes path segments so an id cannot escape its position", async () => {
    const mock = stub(() => json({ membershipId: "m" }));
    await apiClient.tas.remove("c/1", "../../admin", opts);
    expect(String(mock.mock.calls[0]![0])).toBe("/api/courses/c%2F1/tas/..%2F..%2Fadmin");
  });

  it("sets a JSON content type only when there is a body", async () => {
    const mock = stub(() => json({ configs: [] }));
    await apiClient.llmConfigs.list("c1", opts);
    expect((mock.mock.calls[0]![1]!.headers as Record<string, string>)["content-type"]).toBeUndefined();

    await apiClient.tas.add("c1", ["ada"], opts);
    expect((mock.mock.calls[1]![1]!.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("returns the parsed payload on success", async () => {
    stub(() => json({ configs: [{ id: "x", name: "Socratic" }] }));
    const result = await apiClient.llmConfigs.list("c1", opts);
    expect(result.configs[0]!.name).toBe("Socratic");
  });
});

describe("apiClient.knowledge", () => {
  // The brief's own verbatim `vi.fn(async () => new Response(...))` fails
  // `tsc -b`: a callback declared with zero parameters makes vitest infer
  // `mock.calls` as `[][]`, and indexing an empty tuple is TS2493. `stub()`
  // above already exists in this file for exactly this shape, so every case
  // here (including the three lifted straight from the brief) goes through
  // it instead of repeating the untyped literal.
  it("lists documents under the course path", async () => {
    const fetchMock = stub(() => json({ documents: [] }));

    await apiClient.knowledge.listDocuments("c1", { signal: null });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/courses/c1/knowledge/documents");
  });

  it("sends an upload as multipart without a JSON content-type", async () => {
    const fetchMock = stub(() => json({ id: "m1" }, 201));

    const file = new File(["hi"], "a.txt", { type: "text/plain" });
    await apiClient.knowledge.uploadMaterial("c1", file, { signal: null });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBeInstanceOf(FormData);
    // Letting the browser set the multipart boundary is the point: an
    // explicit content-type here produces a body the server cannot parse.
    expect(new Headers(init.headers).get("content-type")).toBeNull();
  });

  it("encodes ids into the resolve query rather than the path", async () => {
    const fetchMock = stub(() => json({ level: "none", collectionIds: [], documents: [] }));

    await apiClient.knowledge.resolve("c1", { homeworkId: "hw 1" }, { signal: null });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/courses/c1/knowledge/resolve?homeworkId=hw+1",
    );
  });

  it("uploads the file under the 'file' form field", async () => {
    const fetchMock = stub(() => json({ id: "m1" }, 201));

    const file = new File(["hi"], "a.txt", { type: "text/plain" });
    await apiClient.knowledge.uploadMaterial("c1", file, { signal: null });

    const init = fetchMock.mock.calls[0]![1]!;
    const form = init.body as FormData;
    expect(form.get("file")).toBe(file);
  });

  it("posts to the reingest endpoint and reports whether a document was created", async () => {
    const fetchMock = stub(() => json({ status: "pending", documentCreated: false }));

    const result = await apiClient.knowledge.reingestMaterial("c1", "m1", { signal: null });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/courses/c1/materials/m1/reingest");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(result.documentCreated).toBe(false);
  });

  it("omits every unset field from the resolve query rather than sending it empty", async () => {
    const fetchMock = stub(() => json({ level: "none", collectionIds: [], documents: [] }));

    await apiClient.knowledge.resolve("c1", {}, { signal: null });

    // No hole in the path, and no trailing "?" advertising a query with
    // nothing in it.
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/courses/c1/knowledge/resolve");
  });

  it("sends only the ids that are actually set when several are present", async () => {
    const fetchMock = stub(() => json({ level: "none", collectionIds: [], documents: [] }));

    await apiClient.knowledge.resolve(
      "c1",
      { homeworkId: "hw1", sectionId: undefined, llmConfigId: "cfg1" },
      { signal: null },
    );

    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://x");
    expect(url.searchParams.get("homeworkId")).toBe("hw1");
    expect(url.searchParams.get("llmConfigId")).toBe("cfg1");
    expect(url.searchParams.has("sectionId")).toBe(false);
  });

  it("encodes a document id containing a slash so it cannot escape its path segment", async () => {
    const fetchMock = stub(() => new Response(null, { status: 204 }));

    await apiClient.knowledge.deleteDocument("c1", "../admin", { signal: null });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/courses/c1/knowledge/documents/..%2Fadmin",
    );
  });

  it("GETs a collection's items and returns them as-is (documents and directories, not resolved documents)", async () => {
    const items = [{ documentId: "d1" }, { directoryPath: "week1" }];
    const fetchMock = stub(() => json({ items }));

    const result = await apiClient.knowledge.getCollectionItems("c1", "col1", opts);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/courses/c1/knowledge/collections/col1/items");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "GET" });
    expect(result.items).toEqual(items);
  });

  it("PUTs the collection items as a body object keyed by 'items'", async () => {
    const fetchMock = stub(() => new Response(null, { status: 204 }));

    await apiClient.knowledge.setCollectionItems(
      "c1",
      "col1",
      [{ documentId: "d1" }],
      { signal: null },
    );

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ items: [{ documentId: "d1" }] });
  });

  it("attach wraps the scope under a 'scope' key", async () => {
    const fetchMock = stub(() => new Response(null, { status: 204 }));

    await apiClient.knowledge.attach(
      "c1",
      "col1",
      { kind: "homework", homeworkId: "hw1" },
      { signal: null },
    );

    const init = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      scope: { kind: "homework", homeworkId: "hw1" },
    });
  });
});
