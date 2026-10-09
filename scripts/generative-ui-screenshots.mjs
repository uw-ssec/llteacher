/* Screenshot review for the subject generative-UI figures.

   Runs the REAL student app (Vite, port 2311) with its API mocked so a
   section conversation's history holds persisted figure tool calls -- the
   same parts the server stores and replays -- for ECON 201, two NMETH 527
   clinical informatics threads, a screening-test thread and a statistics
   thread (with an answered knowledge check). Captures light and dark at three widths and fails
   on page errors, a missing figure, or a figure wider than the chat column.

   Usage (student app running on :2311):
     npx tsx scripts/generative-ui-screenshots.mjs [outDir]                   */

import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { FIGURE_FIXTURES } from "../packages/ui/src/generative/figure/fixtures.ts";

const output = path.resolve(process.argv[2] ?? "artifacts/generative-ui");
await mkdir(output, { recursive: true });

const tool = (name, i) => ({
  type: `tool-${name}`,
  toolCallId: `call-${name}-${i}`,
  state: "output-available",
  input: FIGURE_FIXTURES[name],
  output: { status: "displayed" },
});
const ai = (seq, parts) => ({ id: `m${seq}`, seq, role: "assistant", parts, createdAt: "2026-10-08T17:00:00Z" });
const student = (seq, text) => ({ id: `m${seq}`, seq, role: "user", parts: [{ type: "text", text }], createdAt: "2026-10-08T17:01:00Z" });

const THREADS = {
  econ: {
    course: "ECON 201",
    homework: "HW 4 · Aggregate demand and supply",
    sections: ["The AD-AS model", "Fiscal policy", "Measuring the economy"],
    messages: [
      ai(1, [{ type: "text", text: "Let's look at what happens to the economy when **consumer confidence falls**. Which curve do you think moves?" }]),
      student(2, "Aggregate demand, because people spend less?"),
      ai(3, [{ type: "text", text: "Exactly. Here's the diagram:" }, tool("showMacroModel", 3), { type: "text", text: "Notice both the price level and real GDP fall. What could policy do about that gap?" }]),
      student(4, "The government could spend more?"),
      ai(5, [{ type: "text", text: "Right, and each dollar gets re-spent. Here's how far it goes with an MPC of 0.8:" }, tool("showMultiplier", 5)]),
      student(6, "What does GDP actually consist of?"),
      ai(7, [tool("showGdpComposition", 7), tool("showLaborForce", 7), tool("showInflation", 7), tool("showWorkedSteps", 7)]),
    ],
  },
  nmeth: {
    course: "NMETH 527",
    homework: "Module 2 · Health IT and the Quadruple Aim",
    sections: ["Why informatics", "Sociotechnical systems", "Data, standards and history"],
    messages: [
      ai(1, [{ type: "text", text: "Let's weigh bar-code medication administration against all four aims, not just safety:" }, tool("showQuadrupleAim", 1)]),
      student(2, "Why do nurses work around the scanners then?"),
      ai(3, [tool("showSociotechnicalModel", 3), { type: "text", text: "Which of these dimensions could your unit change first?" }]),
      student(4, "How does an assessment become a decision?"),
      ai(5, [tool("showDikw", 5)]),
      student(6, "What changes in the workflow with BCMA?"),
      ai(7, [tool("showWorkflowComparison", 7)]),
      student(8, "Which standards carry the admission assessment?"),
      ai(9, [tool("showStandardsMap", 9), tool("showHealthItTimeline", 9)]),
    ],
  },
  nmethqi: {
    course: "NMETH 527",
    homework: "Module 4 · Implementation and evaluation",
    sections: ["Measuring change", "Usability and adoption", "Decision support"],
    messages: [
      ai(1, [{ type: "text", text: "Here's your unit's BCMA scanning compliance, week by week:" }, tool("showRunChart", 1)]),
      student(2, "The nurses say the new flowsheet is clunky. How do we show that?"),
      ai(3, [tool("showUsabilityScore", 3), tool("showAdoptionCurve", 3)]),
      student(4, "Why do so many sepsis alerts turn out to be false?"),
      ai(5, [tool("showPrevalenceEffect", 5), tool("showCdsRule", 5), tool("showPatientTimeline", 5)]),
    ],
  },
  tests: {
    course: "BIOST 310",
    homework: "Screening tests",
    sections: ["Accuracy", "Cut-offs"],
    messages: [
      ai(1, [tool("showDiagnosticAccuracy", 1)]),
      student(2, "How do we pick the cutoff?"),
      ai(3, [tool("showRocCurve", 3)]),
    ],
  },
  stats: {
    course: "STAT 311",
    homework: "HW 5 · Sampling distributions",
    sections: ["The normal distribution", "Tail probabilities"],
    messages: [
      ai(1, [{ type: "text", text: "Here's the standard normal with the upper tail shaded:" }, tool("showDistribution", 1)]),
      ai(2, [{ type: "text", text: "Quick check before we go on:" }, {
        type: "tool-knowledgeCheck", toolCallId: "call-kc-2", state: "output-available",
        input: { question: "About what share of a normal distribution lies more than 1.96 SD above the mean?", options: ["2.5%", "5%", "1.96%", "50%"] },
        output: { status: "awaiting_response" },
      }]),
      { id: "m3", seq: 3, role: "user", createdAt: "2026-10-08T17:02:00Z", parts: [
        { type: "text", text: 'My answer to the check "About what share of a normal distribution lies more than 1.96 SD above the mean?": A. 2.5%' },
        { type: "data-knowledge-check-response", data: { toolCallId: "call-kc-2", selectedIndex: 0 } },
      ] },
      ai(4, [{ type: "text", text: "Yes: 2.5% in each tail, 5% in both together. Now try one yourself:" }, {
        type: "tool-knowledgeCheck", toolCallId: "call-kc-4", state: "output-available",
        input: { question: "If the cutoff moves from 1.96 to 1.645, the upper tail is…", options: ["Larger", "Smaller", "Unchanged"] },
        output: { status: "awaiting_response" },
      }]),
    ],
  },
};

const browser = await chromium.launch();
const failures = [];
try {
  for (const [subject, thread] of Object.entries(THREADS)) {
    for (const theme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        if (theme === "dark") {
          await page.addInitScript(() => {
            const apply = () => document.documentElement?.setAttribute("data-theme", "dark");
            apply();
            document.addEventListener("DOMContentLoaded", apply);
          });
        }
        const course = { id: "course-visual", title: thread.course, role: "student", canViewSolutions: false, canViewDrafts: false };
        const sections = thread.sections.map((title, i) => ({
          id: `section-${i}`, title, order: i + 1, status: i === 0 ? "in_progress" : "not_started",
          conversationId: i === 0 ? "conversation-visual" : null, submissionSource: null,
        }));
        await page.route("**/api/**", async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          let body;
          if (pathname === "/api/profile") body = { userId: "u", email: "s@uw.edu", displayName: "Student", role: "student", courses: [course], courseCount: 1, studentStats: { submissionsCount: 0, completedSections: 0 } };
          else if (pathname === "/api/hello") body = { message: "ok", ping_id: "visual" };
          else if (pathname === "/api/student/homeworks") body = { homeworks: [{ id: "hw", courseId: course.id, courseName: thread.course, title: thread.homework, description: "", dueDate: "2027-01-01T00:00:00Z", completedPercentage: 0, inProgressPercentage: 33, sections, widgets: [] }] };
          else if (pathname.endsWith("/messages")) body = thread.messages;
          else if (pathname.endsWith("/hints")) body = { count: 0, limit: null };
          else if (pathname === "/api/conversations") body = { items: [], nextCursor: null };
          else throw new Error(`Unmocked: ${pathname}`);
          await route.fulfill({ json: body });
        });
        const name = `${subject}-${theme}-${viewport.width}`;
        try {
          await page.goto(process.env.VISUAL_WEB_ORIGIN ?? "http://localhost:2311/");
          await page.waitForLoadState("networkidle");
          const figures = page.locator("figure.gen-figure");
          const expected = thread.messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-")).length;
          await expect(figures).toHaveCount(expected, { timeout: 10_000 });
          await page.evaluate(() => document.fonts.ready);
          // Narrow screens: collapse both rails first, as a student on a
          // phone does (and as design-system-screenshots.mjs does).
          if (viewport.width <= 800) {
            for (const rail of [".sidebar", ".tutor-sidebar"]) {
              const toggle = page.locator(rail).locator("button[aria-expanded='true']").first();
              if (await toggle.count()) await toggle.click();
            }
          }
          // Every figure fits its column: no horizontal overflow of the plate,
          // and no SVG wider than the plate it sits in.
          const overflow = await figures.evaluateAll((els) => els.flatMap((el) => {
            const plate = el.getBoundingClientRect();
            const column = el.closest(".conversation-column")?.getBoundingClientRect();
            const issues = [];
            if (column && plate.right > column.right + 1) issues.push(`${el.getAttribute("aria-label")?.slice(0, 40)}: wider than column`);
            for (const svg of el.querySelectorAll("svg")) {
              if (svg.getBoundingClientRect().width > plate.width + 1) issues.push(`${el.getAttribute("aria-label")?.slice(0, 40)}: svg overflows`);
            }
            return issues;
          }));
          if (overflow.length) throw new Error(overflow.join("; "));
          if (errors.length) throw new Error(errors.join("; "));
          await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" });
          // The conversation scrolls inside its own column, so the page shot
          // shows only the viewport: capture every figure as it sits in the chat.
          for (let i = 0; i < expected; i++) {
            const fig = figures.nth(i);
            const tool = (await fig.getAttribute("aria-label"))?.split(/[.:,]/)[0]?.trim().replace(/\W+/g, "-").toLowerCase().slice(0, 32);
            await fig.screenshot({ path: path.join(output, `${name}-${i + 1}-${tool}.png`), animations: "disabled" });
          }
          console.log(`ok   ${name} (${expected} figures)`);
        } catch (e) {
          failures.push(`${name}: ${e.message}`);
          console.log(`FAIL ${name}: ${e.message}`);
          await page.screenshot({ path: path.join(output, `${name}-FAILED.png`), fullPage: true }).catch(() => {});
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
if (failures.length) process.exit(1);
