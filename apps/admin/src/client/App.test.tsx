import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import App from "./App";
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

/** #42/#23: the knowledge views existed and were tested in isolation, but
 *  nothing routed to them -- App.tsx had no case for the `knowledge` nav key
 *  and imported none of the four views, so clicking the sidebar entry
 *  rendered nothing. This suite is the wiring's own test: the nav key
 *  reaches the bundle browser, a TA never sees the entry (authorOnly, same
 *  gating as llm-configs/students/ta-permissions/exports), and a document
 *  opened from a folder returns to that exact folder on "back" rather than
 *  the browser's root default. */
describe("Knowledge navigation (#42, #23)", () => {
  const KNOWLEDGE_DOCUMENTS = [
    {
      id: "d1", path: "week1/lecture", kind: "concept", type: "transcript",
      title: "Lecture 1", description: null, tags: null, indexStatus: "indexed",
      sourceMaterialId: null, updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "d2", path: "syllabus", kind: "concept", type: "syllabus",
      title: "Syllabus", description: null, tags: null, indexStatus: "indexed",
      sourceMaterialId: null, updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  function stubProfile(courses: unknown[], topLevelRole = "instructor") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/profile")) {
          return new Response(JSON.stringify({ userId: "u1", role: topLevelRole, courses }), {
            status: 200,
          });
        }
        if (url.includes("/homeworks")) {
          return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
        }
        // Checked ahead of the plain document-list/document-detail branches
        // below, since a links URL also contains "/knowledge/documents/".
        if (url.endsWith("/links")) {
          return new Response(JSON.stringify({ outbound: [], backlinks: [] }), { status: 200 });
        }
        if (url.endsWith("/knowledge/documents")) {
          return new Response(JSON.stringify({ documents: KNOWLEDGE_DOCUMENTS }), { status: 200 });
        }
        if (url.includes("/knowledge/documents/")) {
          const id = url.split("/").pop();
          const doc = KNOWLEDGE_DOCUMENTS.find((d) => d.id === id);
          return new Response(
            JSON.stringify({ ...doc, body: "Body text", bodyOriginal: null, frontmatter: null, editedAt: null }),
            { status: 200 },
          );
        }
        if (url.includes("/knowledge/collections")) {
          return new Response(JSON.stringify({ collections: [] }), { status: 200 });
        }
        if (url.includes("/knowledge/attachments")) {
          return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
        }
        if (url.includes("/materials")) {
          return new Response(JSON.stringify({ materials: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
  }

  it("navigates to the knowledge base from the sidebar", async () => {
    stubProfile([
      { id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true },
    ]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Knowledge/ }));
    await waitFor(() => screen.getByText(/Knowledge base/));
  });

  it("does not offer knowledge to a TA, whose requests would 403", async () => {
    stubProfile(
      [{ id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false }],
      "ta",
    );
    renderApp();
    await waitFor(() => screen.getByRole("navigation"));
    expect(screen.queryByRole("button", { name: /Knowledge/ })).toBeNull();
  });

  /* Beyond the brief: the sidebar has one Knowledge entry, not two.
     Collections is reached through a segmented control within the knowledge
     surface rather than a second nav item -- this confirms that path
     actually works, not just that the view exists in isolation. */
  it("reaches Collections through the segmented control within Knowledge", async () => {
    stubProfile([
      { id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true },
    ]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Knowledge/ }));
    await waitFor(() => screen.getByText(/Knowledge base/));

    fireEvent.click(screen.getByRole("button", { name: "Collections" }));
    await waitFor(() => screen.getByText(/RECORDS/));
  });

  /* Beyond the brief: App.tsx's own View union follows the transcript-list/
     returnToGrade convention of carrying the state needed to reconstruct the
     screen a drill-in came from. This is that convention's own test for the
     knowledge surface -- opening a document from inside "week1" and coming
     back must show "week1" again, not silently reset to the bundle's root. */
  it("returns to the folder a document was opened from, not the browser's root", async () => {
    stubProfile([
      { id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true },
    ]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Knowledge/ }));
    await waitFor(() => screen.getByText(/Knowledge base/));

    // Root shows only the root-level document until "week1" is opened.
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.click(screen.getByRole("button", { name: /week1/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Lecture 1" }));

    // Landed on the document editor.
    await waitFor(() => screen.getByText(/Referenced by/));

    // "Back" restores week1, not root: Lecture 1 is visible again and
    // Syllabus (root-level) is not.
    fireEvent.click(screen.getByRole("button", { name: "Knowledge base" }));
    await waitFor(() => screen.getByText("Lecture 1"));
    expect(screen.queryByText("Syllabus")).toBeNull();
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
