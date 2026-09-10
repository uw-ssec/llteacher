import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import App, { FeedbackDashboardDataLoader } from "./App";
import { AuthProvider } from "./components/AuthProvider";

afterEach(cleanup);

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe("App auth gate", () => {
  it("shows the login prompt when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderApp();
    await waitFor(() => screen.getByText(/log in/i));
  });

  it("shows a branded 403 for a signed-in student", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "student" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/403/));
  });

  it("renders the admin console for a signed-in instructor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "instructor" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
  });
});

describe("Submissions sidebar shortcut", () => {
  it("navigates using the real homework list, not the HOMEWORKS fixture's non-UUID ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profile")) {
        return new Response(
          JSON.stringify({ userId: "u1", role: "instructor", courses: [{ id: "course-real-uuid", title: "STATS 311" }] }),
          { status: 200 },
        );
      }
      if (url === "/api/courses/course-real-uuid/homeworks") {
        return new Response(
          JSON.stringify({
            homeworks: [
              { id: "hw-real-uuid-1", title: "HW A", description: "", dueDate: "2026-01-01T00:00:00.000Z", llmConfigId: null, status: "draft", sectionCount: 1 },
              { id: "hw-real-uuid-2", title: "HW B", description: "", dueDate: "2026-02-01T00:00:00.000Z", llmConfigId: null, status: "active", sectionCount: 2 },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/courses/course-real-uuid/homeworks/hw-real-uuid-2/submissions") {
        return new Response(
          JSON.stringify({
            homeworkId: "hw-real-uuid-2", homeworkTitle: "HW B", homeworkDueDate: "2026-02-01T00:00:00.000Z",
            sectionHeaders: [], students: [], missingSectionWarnings: [],
            aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));

    const submissionsLabel = screen.getAllByText("Submissions").find((el) => el.closest("button"));
    fireEvent.click(submissionsLabel!.closest("button")!);

    // Picks the "active" homework from the real list (hw-real-uuid-2 /
    // "HW B"), not HOMEWORKS[0]'s fixture id -- only reachable if the
    // submissions fetch used the real-list-derived id, since a fixture id
    // isn't one of the two URLs mocked above and the request would fall
    // through to the catch-all {} response, which SubmissionsView can't
    // render "HW B" from.
    await waitFor(() => screen.getByText("HW B"));
    expect(fetchMock).toHaveBeenCalled();
  });
});

/** #172: a TA belongs in this console -- they have grading work to do -- but
 *  must not be shown authoring affordances whose requests the server
 *  refuses. Gating is per course, from /api/profile's `courses[].role`, not
 *  from the priority-ranked top-level `role`. */
describe("TA console gating (#172)", () => {
  function stubProfile(courses: unknown[], topLevelRole = "instructor") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/profile")) {
          return new Response(
            JSON.stringify({ userId: "u1", role: topLevelRole, courses }),
            { status: 200 },
          );
        }
        if (url.includes("/homeworks")) {
          return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ tas: [] }), { status: 200 });
      }),
    );
  }

  it("admits a TA to the console", async () => {
    stubProfile(
      [{ id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false }],
      "ta",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
  });

  it("hides the New homework quick action from a TA", async () => {
    stubProfile(
      [{ id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false }],
      "ta",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText(/New homework/i)).toBeNull();
  });

  it("shows the New homework quick action to an instructor", async () => {
    stubProfile([
      { id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true },
    ]);
    renderApp();
    await waitFor(() => screen.getAllByText(/New homework/i));
  });

  /* The case the top-level primary role gets wrong: instructor in one course,
     TA in the active one. Priority ranking reports "instructor", so gating on
     it would show authoring controls the server refuses for this course. */
  it("gates on the active course, not the priority-ranked primary role", async () => {
    stubProfile(
      [
        { id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false },
        { id: "c2", title: "STATS 390", role: "instructor", canViewSolutions: true, canViewDrafts: true },
      ],
      "instructor",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText(/New homework/i)).toBeNull();
  });

  /* Version skew: an older apps/web returns courses without role/capability
     fields. The entry must stay usable rather than being dropped (which
     would render "No course found") -- but it degrades to the NARROWEST
     console role, not the caller's priority-ranked widest one.
     #172 audit (SEC-005/REL-007/CMP-003): falling back to the primary role
     showed authoring controls for a course the server refuses, which is the
     defect #172 exists to fix, resurrected for the length of a deploy. */
  it("degrades a pre-#172 profile payload to the narrowest console role", async () => {
    stubProfile([{ id: "c1", title: "STATS 311" }], "instructor");
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    // Usable (not dropped) ...
    expect(screen.queryByText(/No course found/i)).toBeNull();
    // ... but not granted authoring on the strength of a missing field.
    expect(screen.queryByText(/New homework/i)).toBeNull();
  });

  /* A role this bundle does not recognise means a NEWER server. Inheriting
     the primary role there widens on a value that was explicitly narrower,
     so the entry is dropped instead. */
  it("drops a course whose role this bundle does not recognise", async () => {
    stubProfile([{ id: "c1", title: "STATS 311", role: "grader", canViewSolutions: true, canViewDrafts: true }]);
    renderApp();
    await waitFor(() => screen.getByText(/No course found/i));
  });
});

/** #172 FUN-002 and its re-audit (FUN-101).
 *
 *  The gating above covers who sees which affordances. What had no test at
 *  all was the ROUTING: which view a non-author actually lands on when they
 *  open a homework, and whether the instructor-only surface is reachable. A
 *  mutation run confirmed the read-only routing could be deleted outright
 *  with the admin suite green -- restoring the dead end FUN-002 fixed. */
describe("homework routing by per-course role (#172, FUN-002)", () => {
  function stubProfile(role: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/profile")) {
          return new Response(
            JSON.stringify({
              userId: "u1",
              role,
              courses: [
                { id: "c1", title: "STATS 311", role, canViewSolutions: false, canViewDrafts: false },
              ],
            }),
            { status: 200 },
          );
        }
        // Homework detail -- checked before the list, since both paths
        // contain "/homeworks". One payload serves both views: the editor
        // reads the publish/hide/widget fields, the read-only view ignores
        // them, and using the same fixture for both is what makes the two
        // tests below a genuine comparison.
        if (/\/homeworks\/[^/]+$/.test(url)) {
          return new Response(
            JSON.stringify({
              id: "hw-1", title: "Probability", description: "d",
              dueDate: "2099-01-01T00:00:00.000Z", status: "active",
              llmConfigId: null, releasedAt: null, publishedAt: null,
              isHidden: false, expiresAt: null, widgets: [],
              sections: [
                { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/homeworks")) {
          return new Response(
            JSON.stringify({
              homeworks: [
                { id: "hw-1", title: "Probability", description: "d",
                  dueDate: "2099-01-01T00:00:00.000Z", llmConfigId: null,
                  status: "active", isHidden: false, expiresAt: null, sectionCount: 1 },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ tas: [] }), { status: 200 });
      }),
    );
  }

  async function openFirstHomework() {
    const opener = await waitFor(() => screen.getByRole("button", { name: /^Open / }));
    fireEvent.click(opener);
  }

  it("routes a TA to the read-only view rather than a permission dead end", async () => {
    stubProfile("ta");
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    await openFirstHomework();

    await waitFor(() => screen.getByText(/read-only/i));
    // The dead end this replaced, and the absence of any write affordance.
    expect(screen.queryByText(/do not have permission/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("routes an instructor on the same route to the editor", async () => {
    stubProfile("instructor");
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    await openFirstHomework();

    // The contrast that makes the assertion above about the ROLE rather
    // than about this route always being read-only.
    await waitFor(() => expect(screen.queryByText(/read-only/i)).toBeNull());
    await waitFor(() => expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0));
  });

  it("hides the TA-permissions nav entry from a TA and shows it to an instructor", async () => {
    stubProfile("ta");
    const asTa = renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText("TA permissions")).toBeNull();
    asTa.unmount();

    stubProfile("instructor");
    renderApp();
    await waitFor(() => screen.getByText("TA permissions"));
  });
});

/* --------------------------------------------------------------------------
   #193 (#172 re-audit, USE-024): the console says so when it has degraded
   the caller to read-only.

   The reachable condition is this feature's own rolling deploy: the admin
   bundle updates before the Worker, so /api/profile briefly returns the
   pre-#172 course shape with no `role`. parseCourse degrades that to the
   narrowest console role -- correct, and unchanged here -- and the console
   then hides the authoring controls a real instructor had a moment ago.
   -------------------------------------------------------------------------- */
describe("degraded-permissions banner (#193)", () => {
  const profile = (courses: unknown[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/profile")) {
        return new Response(JSON.stringify({ userId: "u1", role: "instructor", courses }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

  it("explains the degrade when the active course arrived without a role", async () => {
    vi.stubGlobal("fetch", profile([{ id: "c1", title: "STATS 311" }]));
    renderApp();
    // Named against the banner's own text, not the page: TopNav carries a
    // hardcoded "STATS 311" of its own until the course switcher (#70).
    const banner = await screen.findByText(/Some permissions could not be confirmed/i);
    expect(banner.textContent).toMatch(/for STATS 311/);
    // The security posture is untouched: still read-only, still no New
    // homework button. The banner adds the explanation, not the access.
    expect(screen.queryByRole("button", { name: /new homework/i })).toBeNull();
  });

  it("stays silent when the server stated a role", async () => {
    vi.stubGlobal(
      "fetch",
      profile([{ id: "c1", title: "STATS 311", role: "instructor" }]),
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText(/Some permissions could not be confirmed/i)).toBeNull();
  });

  it("can be dismissed", async () => {
    vi.stubGlobal("fetch", profile([{ id: "c1", title: "STATS 311" }]));
    renderApp();
    await waitFor(() => screen.getByText(/Some permissions could not be confirmed/i));
    fireEvent.click(screen.getByRole("button", { name: /dismiss permissions notice/i }));
    expect(screen.queryByText(/Some permissions could not be confirmed/i)).toBeNull();
  });
});

/* --------------------------------------------------------------------------
   #440 audit fix 1 (Major, Accessibility): FeedbackDashboardDataLoader used
   to call setData(null) on every offset/courseId change while rendering
   `if (!data) return null` -- unmounting the ENTIRE feedback dashboard,
   including whichever Previous/Next button the instructor had just clicked,
   on every single pagination click (not just at a first-load or error
   boundary). That drops keyboard/screen-reader focus to <body> every time a
   page turns. The fix keeps rendering the previous page's data (and its
   DOM) while a new page fetch is in flight, tracked via a separate
   `isFetching` flag instead of `data === null`.
   -------------------------------------------------------------------------- */
describe("Feedback dashboard pagination doesn't unmount mid-fetch (#440 audit fix 1)", () => {
  it("keeps the Previous/Next buttons mounted while the next page's fetch is still pending", async () => {
    let resolveSecondPage: (() => void) | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profile")) {
        return new Response(
          JSON.stringify({
            userId: "u1",
            role: "instructor",
            courses: [{ id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/instructor/feedback")) {
        const offset = new URL(url, "http://localhost").searchParams.get("offset");
        const page = (o: number) => ({
          items: [
            {
              id: `flag-${o}`,
              conversationId: `conv-${o}`,
              messageId: "msg-1",
              studentId: "student-1",
              studentName: "Ada Lovelace",
              reason: "incorrect",
              comment: null,
              responseSnapshot: [{ type: "text", text: "Some response." }],
              isDeleted: false,
              sectionId: "sec-1",
              sectionTitle: "Section 2",
              homeworkId: "hw-1",
              homeworkTitle: "HW 1",
              flaggedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          total: 4,
          limit: 2,
          offset: o,
        });
        if (offset === "2") {
          // Held open deliberately -- this is the "fetch pending" window the
          // test asserts the DOM survives.
          return new Promise<Response>((resolve) => {
            resolveSecondPage = () => resolve(new Response(JSON.stringify(page(2)), { status: 200 }));
          });
        }
        return new Response(JSON.stringify(page(0)), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));

    const feedbackNav = screen.getAllByText("Feedback").find((el) => el.closest("button"));
    fireEvent.click(feedbackNav!.closest("button")!);

    await waitFor(() => screen.getByTestId("feedback-next-page"));
    expect(screen.getByTestId("feedback-prev-page")).toBeTruthy();

    fireEvent.click(screen.getByTestId("feedback-next-page"));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("offset=2"))).toBe(true));

    // The second page's fetch is still pending (resolveSecondPage hasn't
    // been called) -- pre-fix, `setData(null)` at the top of the effect
    // would have already unmounted the whole dashboard by now, taking the
    // buttons with it.
    expect(screen.getByTestId("feedback-prev-page")).toBeTruthy();
    expect(screen.getByTestId("feedback-next-page")).toBeTruthy();

    resolveSecondPage?.();
    await waitFor(() => screen.getByText(/3–4 of 4/));
  });
});

/* --------------------------------------------------------------------------
   Round-2 audit fix regression test (see FeedbackDashboardDataLoader's own
   doc comment, App.tsx ~lines 856-878): a page-turn fetch that actually
   REJECTS -- as opposed to the merely-still-pending case #440 audit fix 1
   covers above -- used to share `loadError` with the initial-load error,
   whose render guard (`if (loadError && !data)`) is false once any page has
   ever loaded. The instructor was left on the same stale page with no
   error, no Retry, and no live-region announcement that the click did
   nothing -- and clicking Previous/Next again couldn't even retry, since
   the target offset (derived from the still-stale `data.offset`/`limit`)
   never changed, so the effect's own deps never re-fired.

   The fix: a separate `pageError` state that only renders (an inline
   role="alert" + Retry, not a full-page takeover) when `data` already holds
   a previous page worth keeping on screen, with Retry bumping the same
   `attempt` counter the initial-load retry uses so it re-fires the effect
   regardless of whether `offset` changed. This pins all three: the previous
   page's data survives the failure, the inline alert+Retry actually appear,
   and clicking Retry genuinely re-issues the fetch at the same (failing)
   offset -- succeeding on the second attempt here so the page eventually
   loads and the alert clears. Reuses this file's own fetchMock/page() shape
   from #440 audit fix 1 directly above.
   -------------------------------------------------------------------------- */
describe("Feedback dashboard page-turn failure surfaces an inline error + Retry (round 2 audit fix)", () => {
  it("keeps the previous page's data on screen, shows an inline role=alert + Retry, and Retry re-fetches the same failing offset", async () => {
    let secondPageAttempts = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profile")) {
        return new Response(
          JSON.stringify({
            userId: "u1",
            role: "instructor",
            courses: [{ id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/instructor/feedback")) {
        const offset = new URL(url, "http://localhost").searchParams.get("offset");
        const page = (o: number) => ({
          items: [
            {
              id: `flag-${o}`,
              conversationId: `conv-${o}`,
              messageId: "msg-1",
              studentId: "student-1",
              studentName: "Ada Lovelace",
              reason: "incorrect",
              comment: null,
              responseSnapshot: [{ type: "text", text: "Some response." }],
              isDeleted: false,
              sectionId: "sec-1",
              sectionTitle: "Section 2",
              homeworkId: "hw-1",
              homeworkTitle: "HW 1",
              flaggedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          total: 4,
          limit: 2,
          offset: o,
        });
        if (offset === "2") {
          secondPageAttempts += 1;
          // First page-turn attempt fails (the regression under test);
          // the retry (second attempt) succeeds.
          if (secondPageAttempts === 1) return new Response(null, { status: 500 });
          return new Response(JSON.stringify(page(2)), { status: 200 });
        }
        return new Response(JSON.stringify(page(0)), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));

    const feedbackNav = screen.getAllByText("Feedback").find((el) => el.closest("button"));
    fireEvent.click(feedbackNav!.closest("button")!);

    await waitFor(() => screen.getByTestId("feedback-next-page"));
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();

    fireEvent.click(screen.getByTestId("feedback-next-page"));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("offset=2"))).toBe(true));

    // (a) the previous (first) page's data is still on screen -- the failed
    // fetch must not have unmounted or blanked the dashboard.
    // (b) an inline role="alert" error and its Retry button appear.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't load that page/i);
    const retryButton = within(alert).getByRole("button", { name: /retry/i });

    // (c) clicking Retry actually re-issues the fetch at the SAME (failing)
    // offset -- a second call to offset=2, not a no-op -- and, since the
    // mock is set up to succeed on this attempt, the page eventually loads
    // and the alert clears.
    fireEvent.click(retryButton);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("offset=2")).length).toBe(2),
    );
    await waitFor(() => screen.getByText(/3–4 of 4/));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* --------------------------------------------------------------------------
   #452 (Cordero review, PR440): FeedbackDashboardDataLoader's fetch effect
   had no request ordering -- an overlapping request's response could be
   silently overwritten by an EARLIER request's response arriving LATER,
   regardless of which one the instructor actually dispatched most
   recently. `useTutorConversations.ts`'s own `requestSeqRef` idiom (a
   monotonic counter, bumped at dispatch, checked again before any state
   write) now guards every write in this effect the same way.

   Driven directly against the exported component (not through the full App
   navigation tree): the real Previous/Next/Retry controls all compute their
   next target from already-loaded `data`, which makes a genuinely
   double-dispatched, out-of-order-resolving pair of requests structurally
   unreachable through those controls alone -- each re-click either targets
   the SAME offset the effect's own dependency array already deduped
   (`onChangeOffset` called twice with an unchanged value never re-fires the
   effect), or the Retry affordance itself unmounts the instant the first
   click's synchronous effect body clears `pageError`, before a second click
   can land on it. Rerendering with two DIFFERENT `offset` props directly
   reproduces the actual race without inventing an unrelated
   courseId-switching flow just to trigger it. -------------------------------------------------------------------------- */
describe("Feedback dashboard pagination ignores an out-of-order stale response (#452)", () => {
  it("keeps the most recently dispatched offset request's data, even when an earlier request's response arrives later", async () => {
    let resolveFirstDispatch: (() => void) | undefined;
    let resolveSecondDispatch: (() => void) | undefined;
    const callsByOffset: Record<number, number> = {};

    const page = (offset: number, studentName: string) => ({
      items: [
        {
          id: `flag-${offset}`,
          conversationId: `conv-${offset}`,
          messageId: "msg-1",
          studentId: "student-1",
          studentName,
          reason: "incorrect",
          comment: null,
          responseSnapshot: [{ type: "text", text: "Some response." }],
          isDeleted: false,
          sectionId: "sec-1",
          sectionTitle: "Section 2",
          homeworkId: "hw-1",
          homeworkTitle: "HW 1",
          flaggedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      total: 6,
      limit: 2,
      offset,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
      // The FIRST dispatch (offset=0, on mount) resolves immediately and
      // isn't part of the race -- only the two overlapping offset=2/offset=4
      // dispatches (both fired before either resolves) are held.
      if (offset === 0) return new Response(JSON.stringify(page(0, "Ada Lovelace")), { status: 200 });
      callsByOffset[offset] = (callsByOffset[offset] ?? 0) + 1;
      const label = offset === 2 ? "STALE offset=2 (superseded before it resolved)" : "FRESH offset=4 (the actual latest dispatch)";
      return new Promise<Response>((resolve) => {
        const respond = () => resolve(new Response(JSON.stringify(page(offset, label)), { status: 200 }));
        if (offset === 2) resolveFirstDispatch = respond;
        else resolveSecondDispatch = respond;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FeedbackDashboardDataLoader
        courseId="c1"
        offset={0}
        onBack={() => {}}
        onChangeOffset={() => {}}
        onOpenTranscript={() => {}}
      />,
    );
    await waitFor(() => screen.getByText("Ada Lovelace"));

    // Two rapid offset changes -- BOTH dispatched before either resolves,
    // exactly the "Next-then-Next-again" (or Next-then-Previous-then-Next)
    // shape Cordero's review describes, just driven directly rather than
    // through the buttons' own already-loaded-data target computation.
    rerender(
      <FeedbackDashboardDataLoader
        courseId="c1"
        offset={2}
        onBack={() => {}}
        onChangeOffset={() => {}}
        onOpenTranscript={() => {}}
      />,
    );
    rerender(
      <FeedbackDashboardDataLoader
        courseId="c1"
        offset={4}
        onBack={() => {}}
        onChangeOffset={() => {}}
        onOpenTranscript={() => {}}
      />,
    );
    await waitFor(() => expect(callsByOffset[2]).toBe(1));
    await waitFor(() => expect(callsByOffset[4]).toBe(1));

    // Resolve OUT of order: the SECOND (most recent) dispatch first, the
    // FIRST (now-stale) dispatch after.
    resolveSecondDispatch?.();
    await waitFor(() => screen.getByText("FRESH offset=4 (the actual latest dispatch)"));

    resolveFirstDispatch?.();
    // THE PIN: the stale first dispatch's late-arriving response must NOT
    // overwrite the screen -- give it a tick to (incorrectly) land if the
    // request-seq guard were absent, then assert it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("STALE offset=2 (superseded before it resolved)")).toBeNull();
    expect(screen.getByText("FRESH offset=4 (the actual latest dispatch)")).toBeTruthy();
  });
});
