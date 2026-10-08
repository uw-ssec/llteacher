import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { fileURLToPath } from "node:url";

const output = path.resolve(process.argv[2] ?? "artifacts/design-system");
const baseline = process.argv[3] ? path.resolve(process.argv[3]) : null;
const showcasePath = fileURLToPath(new URL("./design-system-showcase.tsx", import.meta.url));
await mkdir(output, { recursive: true });
const course = { id: "course-visual", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true };
const homework = { id: "homework-visual", title: "HW 3 · Probability and distributions", description: "Explore probability, distributions, and p-values.", dueDate: "2027-01-15T18:00:00Z", llmConfigId: null, status: "active", isHidden: false, expiresAt: null, sectionCount: 3 };
const sections = ["Random variables", "Probability distributions", "P-values"].map((title, index) => ({ id: `section-${index}`, title, order: index + 1, status: index === 0 ? "in_progress" : "not_started", conversationId: index === 0 ? "conversation-visual" : null }));
const messages = [
  { id: "message-ai", seq: 1, role: "assistant", parts: [{ type: "text", text: "A **random variable** assigns a numerical value to each outcome. What values could the number of heads take when you toss two coins?" }], createdAt: "2026-10-06T12:00:00Z" },
  { id: "message-student", seq: 2, role: "user", parts: [{ type: "text", text: "It could be 0, 1, or 2 heads." }], createdAt: "2026-10-06T12:01:00Z" },
];
// #367: a course instructor who is NOT an Org Admin sees the shared pool as
// reference (View, Copy to this course) and their own course's configs as
// editable; a shared config opens read-only with its test panel still live.
const configBase = { provider: "openrouter", temperature: 0.7, maxCompletionTokens: 1000, fallbackLlmConfigId: null, isActive: true, knowledgeEnabled: true, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
const llmConfigs = [
  { ...configBase, id: "cfg-shared-default", recordNumber: 1, name: "Socratic default", modelName: "gpt-5.3-codex", basePrompt: "You are a patient Socratic tutor. Ask one guiding question at a time and never give the final answer.", isDefault: true, scopeCourseId: null },
  { ...configBase, id: "cfg-shared-free", recordNumber: 2, name: "Free tier", modelName: "google/gemma-4-31b-it:free", basePrompt: "Short answers, plain language.", isDefault: false, scopeCourseId: null },
  { ...configBase, id: "cfg-course-own", recordNumber: 3, name: "STATS 311 R-heavy tutor", modelName: "gpt-5.3-codex", basePrompt: "Prefer worked R examples the student runs themselves.", isDefault: false, scopeCourseId: course.id },
];
const browser = await chromium.launch();
async function expectInsideViewport(page, locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.x < -1 ||
      bounds.y < -1 || bounds.x + bounds.width > viewport.width + 1 ||
      bounds.y + bounds.height > viewport.height + 1) {
    throw new Error(`Clipped element: ${locator}; bounds=${JSON.stringify(bounds)}`);
  }
}
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    for (const screen of ["student", "profile", "admin", "admin-form", "admin-configs", "admin-config-shared", "signed-out", "components", "components-dark"]) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", permissions: ["local-network-access"] });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") console.error(screen, message.text());
      });
      if (screen.startsWith("components")) {
        await page.route("**/__design-system-review", (route) => route.fulfill({
          contentType: "text/html",
          body: `<html${screen.endsWith("dark") ? ' data-theme="dark"' : ""}><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@fs${showcasePath}"></script></body></html>`,
        }));
      }
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (!pathname.startsWith("/api/")) return route.continue();
        let body;
        let status = 200;
        if (pathname === "/api/profile") {
          status = screen === "signed-out" ? 401 : 200;
          body = { userId: "visual-user", email: "visual@uw.edu", displayName: "Visual Reviewer", role: screen.startsWith("admin") ? "instructor" : "student", courses: [course], courseCount: 1, studentStats: { submissionsCount: 2, completedSections: 2 } };
        } else if (pathname === "/api/hello") body = { message: "ok", ping_id: "visual-review" };
        else if (pathname === "/api/student/homeworks") body = { homeworks: [{ ...homework, courseId: course.id, courseName: course.title, sections }] };
        else if (pathname.endsWith("/homeworks")) body = { homeworks: [homework] };
        else if (pathname.endsWith("/llm-configs")) {
          body = screen.startsWith("admin-config") ? { configs: llmConfigs, canManageOrgPool: false } : { configs: [], canManageOrgPool: false };
        }
        else if (pathname.endsWith("/messages")) body = messages;
        else if (pathname.endsWith("/hints")) body = { hints: [] };
        else if (pathname === "/api/conversations") body = { items: [], nextCursor: null };
        else throw new Error(`Unmocked visual-review endpoint: ${pathname}`);
        await route.fulfill({ status, json: body });
      });
      const webOrigin = process.env.VISUAL_WEB_ORIGIN ?? "http://localhost:2311";
      const adminOrigin = process.env.VISUAL_ADMIN_ORIGIN ?? "http://localhost:2312";
      const url = screen.startsWith("admin") ? `${adminOrigin}/admin/` : `${webOrigin}/${screen.startsWith("components") ? "__design-system-review" : screen === "profile" ? "profile" : ""}`;
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      if (screen === "student") await page.getByText("It could be 0, 1, or 2 heads.", { exact: true }).waitFor();
      if (screen === "profile") await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
      if (screen.startsWith("components")) {
        await page.getByRole("heading", { name: "Shared component states" }).waitFor();
        await page.getByRole("button", { name: /account/i }).click();
      }
      if (screen.startsWith("admin-config")) {
        await page.getByRole("button", { name: /LLM configs/ }).first().click();
        await page.getByRole("heading", { name: "Tutor configurations" }).waitFor();
        await expect(page.getByRole("button", { name: "Copy Free tier to this course" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Deactivate Free tier" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Deactivate STATS 311 R-heavy tutor" })).toBeVisible();
      }
      if (screen === "admin-config-shared") {
        await page.getByRole("button", { name: "View" }).nth(1).click();
        await page.getByRole("heading", { name: "Shared configuration" }).waitFor();
        if (!(await page.getByLabel("Name").evaluate((element) => element.matches(":disabled")))) {
          throw new Error("admin-config-shared: shared configuration is editable for a non-admin");
        }
        await expect(page.getByRole("button", { name: /Save changes/ })).toHaveCount(0);
      }
      if (screen === "admin-form") {
        await page.getByRole("button", { name: "New homework", exact: true }).click();
        await page.getByRole("button", { name: /add section/i }).waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      if (screen === "student") {
        await expectInsideViewport(page, page.locator(".conversation-column"));
        await expectInsideViewport(page, page.locator(".composer-wrap"));
        await expectInsideViewport(page, page.getByText("It could be 0, 1, or 2 heads.", { exact: true }));
      }
      if (screen.startsWith("admin")) {
        await expectInsideViewport(page, page.locator(".admin-main"));
        const overflow = await page.locator(".admin-inner").evaluate((element) => element.scrollWidth > element.clientWidth);
        if (overflow) {
          // Name the leaf elements past the content edge, so the failure says
          // what to fix rather than only that something overflowed.
          const culprits = await page.locator(".admin-inner").evaluate((inner) => {
            const edge = inner.getBoundingClientRect().right;
            const past = [...inner.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > edge + 1);
            // Deepest offenders first: a container is only listed if none of
            // its descendants is past the edge itself.
            const deepest = past.filter((element) => !past.some((other) => other !== element && element.contains(other)));
            return [
              `scrollWidth=${inner.scrollWidth} clientWidth=${inner.clientWidth}`,
              ...deepest.slice(0, 5).map((element) =>
                `${element.tagName.toLowerCase()}.${element.className} right=${Math.round(element.getBoundingClientRect().right)} edge=${Math.round(edge)} "${(element.textContent ?? "").trim().slice(0, 40)}"`),
            ];
          });
          throw new Error(`${screen}: admin content overflows horizontally: ${culprits.join("; ")}`);
        }
      }
      if (screen.startsWith("components")) {
        for (const [size, diameter] of [["sm", 5], ["md", 7], ["lg", 9]]) {
          const dot = page.locator(`.streaming-dot > .spinner--${size}`);
          await expect(dot).toBeVisible();
          const styles = await dot.evaluate((element) => {
            const style = getComputedStyle(element);
            return { width: style.width, height: style.height, background: style.backgroundColor, radius: style.borderRadius, opacity: style.opacity };
          });
          if (styles.width !== `${diameter}px` || styles.height !== `${diameter}px` ||
              styles.background === "rgba(0, 0, 0, 0)" || styles.radius !== "50%" || styles.opacity !== "1") {
            throw new Error(`Invisible or incorrectly sized Spinner: ${JSON.stringify(styles)}`);
          }
        }
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect(page.locator(".streaming-dot > .spinner--md")).toHaveCSS("animation-name", "llteacher-stream-wave");
        await page.emulateMedia({ reducedMotion: "reduce" });
      }
      if (errors.length) throw new Error(`${screen}: ${errors.join("; ")}`);
      const filename = `${screen}-${viewport.width}.png`;
      const screenshot = await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: "disabled" });
      if (baseline) {
        const expected = PNG.sync.read(await readFile(path.join(baseline, filename)));
        const actual = PNG.sync.read(screenshot);
        if (expected.width !== actual.width || expected.height !== actual.height ||
            actual.data.some((channel, index) => Math.abs(channel - expected.data[index]) > 1)) {
          throw new Error(`${filename} differs from its baseline; inspect both screenshots.`);
        }
      }
      console.log(`${filename}${baseline ? " (matches baseline)" : ""}`);
      if (viewport.width <= 800 && (screen === "student" || screen === "admin")) {
        const rails = screen === "student" ? [".sidebar", ".tutor-sidebar"] : [".admin-sidebar"];
        for (const selector of rails) {
          const rail = page.locator(selector);
          const toggle = rail.locator("button[aria-expanded]").first();
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expectInsideViewport(page, page.locator(".conversation-column"));
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          const lastAction = rail.getByRole("button").last();
          await lastAction.scrollIntoViewIfNeeded();
          await expectInsideViewport(page, lastAction);
          await rail.evaluate((element) => { element.scrollTop = 0; });
        }
        await page.screenshot({ path: path.join(output, `${screen}-navigation-${viewport.width}.png`), fullPage: true, animations: "disabled" });
        for (const selector of rails) {
          await page.locator(selector).locator("button[aria-expanded]").first().click();
        }
        await expectInsideViewport(page, page.locator(".conversation-column"));
        if (screen === "student") await expectInsideViewport(page, page.locator(".composer-wrap"));
        await page.screenshot({ path: path.join(output, `${screen}-collapsed-${viewport.width}.png`), fullPage: true, animations: "disabled" });
        if (screen === "admin") {
          const row = page.locator(".admin-record-row").first();
          await row.scrollIntoViewIfNeeded();
          await expectInsideViewport(page, row);
          const title = await row.locator(".admin-record-row__title").boundingBox();
          const actions = await row.locator(".admin-record-row__actions").boundingBox();
          if (!title || !actions || actions.y < title.y + title.height) {
            throw new Error("Mobile catalog actions overlap the homework title");
          }
          await page.screenshot({ path: path.join(output, `${screen}-record-${viewport.width}.png`), fullPage: true, animations: "disabled" });
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
