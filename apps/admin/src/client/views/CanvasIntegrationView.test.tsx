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
    expect(putBody).toEqual({ token: "raw-plaintext-token", canvasBaseUrl: "https://uw.instructure.com" });
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

    await waitFor(() => screen.getByText("2 added, 1 updated, 0 removed."));
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
    expect(screen.getByText("1 added, 0 updated, 0 removed.")).toBeTruthy();
  });
});
