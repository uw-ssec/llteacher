/* --------------------------------------------------------------------------
   #73/#74: the Canvas integration view.

   The server-side contract (auth, validation, sync algorithm) is owned by
   apps/web's own route and service test suites. This file owns what the
   instructor actually sees: the token never renders in full, a working
   validation reports success, and the course-link/sync flow reaches the
   right endpoints in the right order.
   -------------------------------------------------------------------------- */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CanvasIntegrationView } from "./CanvasIntegrationView";

afterEach(cleanup);

function stub(handler: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CREDENTIAL = {
  id: "cred-1",
  maskedToken: "ab••••yz",
  canvasBaseUrl: "https://uw.instructure.com",
  expiresAt: null,
  rotatedAt: "2026-09-01T00:00:00.000Z",
};

const IDLE_STATUS = {
  canvasCourseId: null,
  lastSyncStatus: "idle" as const,
  lastSyncCounts: null,
  lastSyncErrorMessage: null,
  lastSyncedAt: null,
};

const renderView = () => render(<CanvasIntegrationView courseId="c1" courseTitle="STATS 311" />);

describe("CanvasIntegrationView -- token settings (#73)", () => {
  it("offers the token form when none is set, and never renders a saved token in full", async () => {
    const fetchMock = stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: null });
      }
      if (url.endsWith("/canvas/credential") && init.method === "PUT") {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByLabelText("API token"));
    fireEvent.change(screen.getByLabelText("Canvas instance URL"), {
      target: { value: "https://uw.instructure.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "raw-plaintext-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => screen.getByText("ab••••yz"));
    expect(document.body.innerHTML).not.toContain("raw-plaintext-token");

    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(putCall).toBeDefined();
    const putBody = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(putBody).toEqual({
      token: "raw-plaintext-token",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });
  });

  it("shows a masked existing token and validates it on request", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/credential/validate")) {
        return jsonRes({ ok: true, canvasUserId: "1", name: "Lauren" });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    expect(screen.queryByLabelText("API token")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    // Matches both the visible result paragraph and the aria-live
    // announcement, which carry the same sentence deliberately (#204-style
    // pairing elsewhere in this app) -- disambiguated by element here since
    // the test only cares that the sentence appears at all.
    await waitFor(() => expect(screen.getAllByText(/connected as Lauren/).length).toBeGreaterThan(0));
  });

  it("reports a failed validation without throwing", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/credential/validate")) {
        return jsonRes({ ok: false, message: "Canvas rejected this token." });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getAllByText("Canvas rejected this token.").length).toBeGreaterThan(0),
    );
  });

  it("shows an overdue expiry warning once past the expiry date", async () => {
    const EXPIRED = { ...CREDENTIAL, expiresAt: "2020-01-01T00:00:00.000Z" };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: EXPIRED });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText(/Expired/));
  });

  it("submits an expiry date entered on a first-time save", async () => {
    const fetchMock = stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: null });
      }
      if (url.endsWith("/canvas/credential") && init.method === "PUT") {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByLabelText("API token"));
    fireEvent.change(screen.getByLabelText("Canvas instance URL"), {
      target: { value: "https://uw.instructure.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText("Expiry date (optional)"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => screen.getByText("ab••••yz"));
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toMatchObject({ expiresAt: "2026-12-01" });
  });

  it("reopens the entry form for Replace token, without prefilling the old token", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    const tokenInput = (await screen.findByLabelText("API token")) as HTMLInputElement;
    expect(tokenInput.value).toBe("");
    expect((screen.getByLabelText("Canvas instance URL") as HTMLInputElement).value).toBe(
      "https://uw.instructure.com",
    );
  });

  it("deletes the token after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/credential") && init.method === "DELETE") {
        return jsonRes({ credential: null });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => screen.getByLabelText("API token"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(true);
    confirmSpy.mockRestore();
  });

  // #10 (usability review, PR #457): the confirm dialog previously never
  // stated the org-wide blast radius (every course, not just this one)
  // or the undo path -- both now match every sibling confirm dialog in
  // this codebase (StudentsView/TaCapabilitiesView).
  it("states the org-wide blast radius and undo path in the removal confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(confirmSpy).toHaveBeenCalled();
    const message = confirmSpy.mock.calls[0]![0] as string;
    expect(message).toMatch(/every course/i);
    expect(message).toMatch(/enter a new token/i);
    confirmSpy.mockRestore();
  });

  // #2 (usability review, PR #457): a transient load failure must not
  // route into the blank "no token on file" entry form -- that reads as
  // "start over" for what's usually a network blip on an org-wide
  // credential that's still saved.
  it("offers a retry, not the blank entry form, when loading the token fails", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ error: "Could not load Canvas token settings." }, 500);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() =>
      expect(screen.getAllByText(/Could not load Canvas token settings/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByLabelText("API token")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  // #9 (usability review, PR #457): nothing previously prompted a check
  // after save -- a mistyped token "saved successfully" with no
  // indication it had never actually been confirmed against Canvas.
  it("automatically validates right after a successful save", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: null });
      }
      if (url.endsWith("/canvas/credential") && init.method === "PUT") {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/credential/validate")) {
        return jsonRes({ ok: false, message: "Canvas rejected this token." });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByLabelText("API token"));
    fireEvent.change(screen.getByLabelText("Canvas instance URL"), {
      target: { value: "https://uw.instructure.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(screen.getAllByText("Canvas rejected this token.").length).toBeGreaterThan(0),
    );
  });

  // Regression: the original handler set savingCredential(true) but never
  // reset it on success, so the button stayed stuck on "Saving…" and a
  // second real save attempt was unreachable.
  it("resets the saving state after a successful save, so the button works again", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: null });
      }
      if (url.endsWith("/canvas/credential") && init.method === "PUT") {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/credential/validate")) {
        return jsonRes({ ok: true, canvasUserId: "1", name: "Lauren" });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByLabelText("API token"));
    fireEvent.change(screen.getByLabelText("Canvas instance URL"), {
      target: { value: "https://uw.instructure.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => screen.getByText("ab••••yz"));
    // Back on the card view now -- "Replace token" re-opens the same form,
    // whose submit button must read "Save token", not still "Saving…".
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    await screen.findByLabelText("API token");
    expect(screen.getByRole("button", { name: "Save token" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
  });

  // #3 (accessibility review, PR #457, ACC-020): Cancel unmounts the form
  // in favor of the card -- without focus restoration, a keyboard user's
  // focus drops to <body>.
  it("restores focus to Replace token after canceling out of the form", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("ab••••yz"));
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    await screen.findByLabelText("API token");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace token" })));
  });
});

describe("CanvasIntegrationView -- course link + sync (#74)", () => {
  it("hides the sync section entirely until a token is on file", async () => {
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByLabelText("API token"));
    expect(screen.queryByText("Course roster sync")).toBeNull();
  });

  it("links a course chosen from the picker", async () => {
    const fetchMock = stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(IDLE_STATUS);
      if (url.endsWith("/canvas/courses")) {
        return jsonRes({
          courses: [{ canvasCourseId: "cc-1", name: "STATS 311", courseCode: "STATS 311 A", term: "Fall" }],
        });
      }
      if (url.endsWith("/canvas/link") && init.method === "PUT") {
        return jsonRes({ lmsIntegrationId: "lms-1", canvasCourseId: "cc-1" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByRole("button", { name: "Link a Canvas course" }));
    fireEvent.click(screen.getByRole("button", { name: "Link a Canvas course" }));

    await waitFor(() => screen.getByLabelText("Canvas course"));
    fireEvent.change(screen.getByLabelText("Canvas course"), { target: { value: "cc-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link this course" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "PUT")).toBe(true),
    );
    const linkCall = fetchMock.mock.calls.find(([u, init]) => String(u).endsWith("/canvas/link") && (init as RequestInit).method === "PUT");
    expect(JSON.parse((linkCall![1] as RequestInit).body as string)).toEqual({ canvasCourseId: "cc-1" });
  });

  it("runs a sync for an already-linked course and shows the result counts", async () => {
    const LINKED_STATUS = { ...IDLE_STATUS, canvasCourseId: "cc-1", lastSyncStatus: "success" as const };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(LINKED_STATUS);
      if (url.endsWith("/canvas/sync") && init.method === "POST") {
        return jsonRes({ added: 2, updated: 1, removed: 0, errors: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByRole("button", { name: /Sync from Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sync from Canvas/ }));

    // #61's own acceptance checklist: the result names both counts AND
    // duration ("2 added, 1 updated, 0 removed in 0.0s." -- exact seconds
    // vary by test-run speed, so this only pins the counts + shape).
    await waitFor(() => screen.getByText(/2 added, 1 updated, 0 removed in \d+\.\d+s\./));
  });

  // #8 (usability review, PR #457): an instructor teaching two sections
  // couldn't tell which one they'd linked from a raw numeric Canvas id.
  it("shows the linked course's name, not just its raw Canvas id", async () => {
    const LINKED_STATUS = {
      ...IDLE_STATUS,
      canvasCourseId: "cc-1",
      canvasCourseName: "STATS 311 (STATS 311 A)",
      lastSyncStatus: "success" as const,
    };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(LINKED_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("STATS 311 (STATS 311 A)"));
    expect(screen.getByText(/Canvas id cc-1/)).toBeTruthy();
  });

  it("falls back to the raw Canvas id when no name was recorded (a link made before #8)", async () => {
    const LINKED_STATUS = {
      ...IDLE_STATUS,
      canvasCourseId: "cc-1",
      canvasCourseName: null,
      lastSyncStatus: "success" as const,
    };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(LINKED_STATUS);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByText("cc-1"));
  });

  it("surfaces per-row sync errors without hiding the successful counts", async () => {
    const LINKED_STATUS = { ...IDLE_STATUS, canvasCourseId: "cc-1", lastSyncStatus: "success" as const };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(LINKED_STATUS);
      if (url.endsWith("/canvas/sync") && init.method === "POST") {
        return jsonRes({
          added: 1,
          updated: 0,
          removed: 0,
          errors: [{ canvasEnrollmentId: "e9", message: "No email address on file." }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByRole("button", { name: /Sync from Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sync from Canvas/ }));

    await waitFor(() => screen.getByText("No email address on file."));
    expect(screen.getByText(/1 added, 0 updated, 0 removed in \d+\.\d+s\./)).toBeTruthy();
  });

  // #7 (usability/reliability review, PR #457): a request-level sync
  // failure (a 409 from #6's concurrency guard, a timeout, a 5xx) must
  // render a visible message, not just post to the screen-reader-only
  // live region -- the previous version left a sighted instructor with
  // zero signal anything went wrong, and the natural next move (click
  // again) was exactly how the concurrency race got triggered.
  //
  // No role="alert" here on purpose (#5, ACC-004): this banner is
  // conditionally mounted already containing its text, which doesn't
  // reliably announce in every screen reader -- the live region above
  // (asserted via the "role=status" query) is the one and only
  // announcement channel, avoiding ACC-025's double-announce.
  it("shows a visible error when the sync request itself fails", async () => {
    const LINKED_STATUS = { ...IDLE_STATUS, canvasCourseId: "cc-1", lastSyncStatus: "success" as const };
    stub((url, init) => {
      if (url.endsWith("/canvas/credential") && (!init.method || init.method === "GET")) {
        return jsonRes({ credential: CREDENTIAL });
      }
      if (url.endsWith("/canvas/status")) return jsonRes(LINKED_STATUS);
      if (url.endsWith("/canvas/sync") && init.method === "POST") {
        return jsonRes({ error: "A sync for this course is already running. Wait for it to finish and try again." }, 409);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderView();

    await waitFor(() => screen.getByRole("button", { name: /Sync from Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sync from Canvas/ }));

    // Two elements carry the text: the visible banner and the live
    // region's own span (both render the identical message; that's the
    // ONE announcement channel, not a double-announce -- see #5's own
    // comment in the view).
    await waitFor(() => expect(screen.getAllByText(/already running/).length).toBeGreaterThan(0));
    expect(screen.getByRole("status").textContent).toMatch(/already running/);
  });
});
