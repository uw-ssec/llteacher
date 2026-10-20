# Instructor Student View and Tutor Chat Implementation Plan

**Status:** Executed on 2026-10-19; PR #501 review corrections applied on 2026-10-20.
The task steps below are the original implementation record. Review corrections
retain preview chrome during errors/loading, exclude teacher-test activity from
unpublish warnings, classify tutor tests, and make marker tooltips dismissible
without repeating screen-reader descriptions. The return link defaults to `/admin/`.

**Goal:** Clearly distinguish every instructor-console navigation destination from Student view and let instructors use a safe, course-scoped student view with their own AI tutor chats.

**Architecture:** The admin console deep-links the selected author-owned course into the existing student web workspace. A new instructor-only API reuses the student-homework projection for that exact course, while the client supplies course context independently of homework so existing owner-scoped tutor APIs work even for an empty course. Preview-only UI suppresses all student-record writes; existing section-chat logic records instructor runs as `isTeacherTest`.

**Tech Stack:** TypeScript 7, React 19, React Router 7, Hono, Effect, Drizzle ORM, Vitest, Testing Library, Phosphor Icons, npm workspaces/Turborepo

**Spec:** `docs/superpowers/specs/2026-10-19-instructor-student-view-and-tutor-chat-design.md`

## Global Constraints

- Instructor preview uses the signed-in instructor’s identity; it never impersonates a student.
- Preview homework is limited to published, released, non-hidden, non-expired work visible to students.
- Preview requires `instructor` or course-scoped `admin` for the exact requested course; TA, observer, student, and unrelated-course memberships are denied.
- Instructor section conversations remain `isTeacherTest` and cannot be submitted.
- Student submissions, self-assessments, section answers, and response feedback are not offered in preview mode.
- Free-standing tutor chats remain persisted, owner-scoped conversations and work even when the course has no visible homework.
- Every rendered left-sidebar console destination has a right-aligned Phosphor `EyeSlash` marker. Review revised the tooltip to “Not visible to students” and one nav-level accessible explanation; existing role gates are unchanged.
- The Student view launch action does not receive the marker because it opens the student-facing workspace.
- No database migration or new dependency is allowed.

## Review Focus

- A hand-edited or stale `courseId` must not fall back to the instructor’s first course or expose another course; Task 3 pins the fallback behavior.
- A course with zero visible homework must still enable Tutor Chats using the selected membership’s course ID; Task 3 pins the empty-list path.
- Mixed-role users must retain the ordinary student workspace unless they deliberately enter a valid author preview; Task 3 pins both modes.
- Preview must not surface Submit, self-assessment saves, section-answer writes, or student-response feedback; Task 3 pins the absence of those calls and controls.
- Expanded navigation must show the eye-slash tooltip on both hover and keyboard focus; collapsed navigation must communicate “Only instructor viewable” without depending on sight or hover. Task 1 pins the visible, pointer, keyboard, and assistive-technology behavior.
- The marker denotes a console-only destination, not a new authorization rule: TAs see it on every console destination they are already permitted to access, while `authorOnly` and `superAdminOnly` filtering remains unchanged.

---

### Task 1: Mark every console navigation destination and add the Student view launch action

**Files:**
- Create: `apps/admin/src/client/lib/studentAppUrl.ts`
- Create: `apps/admin/src/client/lib/studentAppUrl.test.ts`
- Modify: `apps/admin/src/client/components/AdminSidebar.tsx`
- Modify: `apps/admin/src/client/components/AdminSidebar.test.tsx`
- Modify: `apps/admin/src/client/App.tsx`
- Modify: `apps/admin/src/client/App.test.tsx`
- Modify: `packages/ui/styles.css`

**Interfaces:**
- Consumes: `canAuthor`, `CURRENT_COURSE_ID`, the rendered `NAV_ITEMS`, and the existing `NavItem.authorOnly`/`superAdminOnly` metadata only for permission filtering.
- Produces: `studentAppUrl(courseId: string, origin?: string): string`; required `AdminSidebarProps.onViewAsStudent: (() => void) | undefined`; a right-aligned, accessible eye-slash marker on every rendered navigation destination.

- [x] **Step 1: Write failing URL-helper tests**

Add tests asserting that `studentAppUrl("course-a", "https://teacher.example.edu")` returns the same-origin root with `view=student&courseId=course-a`, and that ports `2312` and `2412` map to `2311` and `2411` respectively without losing the query parameters.

- [x] **Step 2: Run the URL-helper test and verify it fails**

Run: `cd apps/admin && npx vitest run src/client/lib/studentAppUrl.test.ts`

Expected: FAIL because `studentAppUrl.ts` does not exist.

- [x] **Step 3: Implement `studentAppUrl(courseId: string, origin = window.location.origin): string`**

Build the URL with `URL`/`URLSearchParams`, use `/` as the production path, and encode only the two established local admin→web port pairs. Do not add a new environment variable.

- [x] **Step 4: Write failing sidebar and shell tests**

In `AdminSidebar.test.tsx`, assert that:

- an author sees a Phosphor `EyeSlash` marker at the right edge of every rendered navigation row, including Homeworks and LLM Configs;
- hovering a row/marker and focusing its navigation button reveal the exact tooltip “Only instructor viewable”;
- each navigation button references an assistive description containing “Only instructor viewable” without making the decorative icon itself a separate tab stop;
- a TA sees the marker on Homeworks, Submissions, and Feedback but still cannot see existing `authorOnly` destinations, proving the marker does not alter role filtering;
- collapsed entries expose `<label> — Only instructor viewable` through both accessible name and `title`;
- the Student view launch action is available only to an author and does not receive the eye-slash marker;
- activating Student view calls `onViewAsStudent` once.

In `App.test.tsx`, select a course, activate Student view, and assert `window.location.assign` receives `studentAppUrl(CURRENT_COURSE_ID)`; also assert a courseless super admin gets no launch action.

- [x] **Step 5: Run the admin component tests and verify they fail**

Run: `cd apps/admin && npx vitest run src/client/components/AdminSidebar.test.tsx src/client/App.test.tsx`

Expected: FAIL because the eye-slash markers, tooltip behavior, accessible descriptions, and launch action are absent.

- [x] **Step 6: Implement the marker and launch action**

Render a Phosphor `EyeSlash` icon after the text block of every mapped navigation destination, using the rendered navigation collection itself rather than `authorOnly` as the marker condition. Keep the icon decorative and right-aligned. Add one visually hidden explanation per row and connect it with `aria-describedby`; show a CSS tooltip containing the exact text “Only instructor viewable” when the navigation row is hovered or focus-visible. In collapsed mode, include the phrase in the button’s accessible name and native `title`. Do not add a separate focus stop or change `authorOnly`/`superAdminOnly` filtering.

Add a Student view sidebar action only when `canAuthor && CURRENT_COURSE_ID`; wire it through `studentAppUrl` from `App.tsx`. Treat it as a bridge action rather than a console destination, so it has no eye-slash marker. Add only the focused styles needed for marker alignment, the tooltip, and the collapsed state.

- [x] **Step 7: Run Task 1 tests**

Run: `npm test --workspace=llteacher-admin -- --run src/client/lib/studentAppUrl.test.ts src/client/components/AdminSidebar.test.tsx src/client/App.test.tsx && npm run lint:design-system`

Expected: all selected tests pass and ESLint reports zero warnings.

- [x] **Step 8: Commit Task 1**

```bash
git add apps/admin/src/client/lib/studentAppUrl.ts apps/admin/src/client/lib/studentAppUrl.test.ts apps/admin/src/client/components/AdminSidebar.tsx apps/admin/src/client/components/AdminSidebar.test.tsx apps/admin/src/client/App.tsx apps/admin/src/client/App.test.tsx packages/ui/styles.css
git commit -m "feat(admin): identify console-only navigation"
```

### Task 2: Add the course-scoped instructor student-view API

**Files:**
- Modify: `apps/web/src/server/repositories/studentHomeworks.ts`
- Modify: `apps/web/src/server/repositories/studentHomeworks.test.ts`
- Modify: `apps/web/src/server/routes/studentHomeworks.ts`
- Modify: `apps/web/src/server/routes/studentHomeworks.test.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `apps/web/src/server/routeGuards.test.ts`

**Interfaces:**
- Consumes: `CourseScope`, `AuthContext.isInstructorOf(courseId)`, the current student-visible `isUnreleased` filter, and caller `userId`.
- Produces: `getInstructorStudentViewHomeworks(db: Db, scope: CourseScope, userId: string): Promise<StudentHomeworkSummary[]>`; `GET /api/courses/:courseId/student-view/homeworks -> StudentHomeworkListResponse`.

- [x] **Step 1: Write failing route tests**

Add tests proving the new handler:

- returns the mocked list for an instructor of the exact course;
- denies an instructor of a different course, a TA, a student, and an unauthenticated request without calling the repository;
- rejects a malformed course ID through the route’s normal not-found/denial shape;
- maps an unexpected repository failure to the existing 503 response.

- [x] **Step 2: Run the route tests and verify they fail**

Run: `cd apps/web && npx vitest run src/server/routes/studentHomeworks.test.ts`

Expected: FAIL because the instructor handler and route do not exist.

- [x] **Step 3: Extract one shared course-list projection**

In `studentHomeworks.ts`, move the current homework/conversation/submission/answer/widget projection behind an internal helper accepting explicit trusted course IDs. Keep `getStudentHomeworksForUser(db, userId)` as the student-membership wrapper and add `getInstructorStudentViewHomeworks(db, scope, userId)` as the one-course wrapper. Both wrappers must preserve `!isUnreleased(deriveHomeworkStatus(hw))` and caller-owned progress queries.

- [x] **Step 4: Add database-backed repository coverage**

Extend `studentHomeworks.test.ts` with a real-DB test that seeds two instructor courses, student-visible and unreleased homework, and an instructor-owned `isTeacherTest` conversation. Assert the instructor wrapper returns only the scoped course’s visible homework, reports only the instructor’s own conversation state, and excludes the other course and unreleased records.

- [x] **Step 5: Implement and register the instructor route**

Add `instructorStudentViewHomeworksHandler`, re-check `isInstructorOf(courseId)` in the handler, create scope only after that check, and register `GET /api/courses/:courseId/student-view/homeworks` with `requireInstructorOf`. Update the route-table guard test so its expected access matrix names this instructor-only read.

- [x] **Step 6: Run Task 2 tests**

Run: `cd apps/web && npx vitest run src/server/routes/studentHomeworks.test.ts src/server/routeGuards.test.ts src/server/repositories/studentHomeworks.test.ts`

Expected: route and guard tests pass; repository DB cases are reported skipped when `DATABASE_URL` is absent.

- [x] **Step 7: Commit Task 2**

```bash
git add apps/web/src/server/repositories/studentHomeworks.ts apps/web/src/server/repositories/studentHomeworks.test.ts apps/web/src/server/routes/studentHomeworks.ts apps/web/src/server/routes/studentHomeworks.test.ts apps/web/src/server/index.ts apps/web/src/server/routeGuards.test.ts
git commit -m "feat(api): serve instructor student-view homework"
```

### Task 3: Render instructor Student view and enable instructor tutor chats

**Files:**
- Modify: `apps/web/src/client/components/AccountShell.tsx`
- Modify: `apps/web/src/client/components/account.css`
- Modify: `apps/web/src/client/hooks/useStudentHomework.ts`
- Create: `apps/web/src/client/hooks/useStudentHomework.test.ts`
- Modify: `apps/web/src/client/App.tsx`
- Modify: `apps/web/src/client/App.test.tsx`
- Modify: `apps/web/src/client/StudentNavigation.test.tsx`
- Modify: `packages/ui/styles.css`

**Interfaces:**
- Consumes: `AuthState.staffCourses`, shared `AUTHOR_ROLES`, the `view=student&courseId=<id>` query, Task 2’s endpoint, existing `useTutorConversations(courseId)`, and existing teacher-test section-chat behavior.
- Produces: `InstructorPreviewCourse = { id: string; code: string; title: string; term: string }`; `useStudentHomework({ previewCourse?: InstructorPreviewCourse })`; a preview banner/exit action; stable course context even when `homeworks` is empty.

- [x] **Step 1: Write failing mode-selection tests**

In `App.test.tsx`, cover:

- a staff-only instructor with a matching author membership and query string enters Student view and calls `/api/courses/<id>/student-view/homeworks`;
- a missing, malformed, unrelated, TA-only, or student-only course request stays on `StaffHome` and never requests preview data;
- a mixed staff/student user stays in the ordinary student workspace unless the requested course has an author role;
- changing the query to a second authorized course clears the first course’s homework and tutor rows before loading the second.

- [x] **Step 2: Run the mode-selection tests and verify they fail**

Run: `cd apps/web && npx vitest run src/client/App.test.tsx`

Expected: FAIL because staff-only users always stop at `StaffHome`.

- [x] **Step 3: Refactor `useStudentHomework` to accept explicit preview context**

Add the optional preview-course input. In preview mode, request Task 2’s endpoint and return `courseId`/`courseName` from the validated membership even when `homeworks` is empty. Keep the current `/api/student/homeworks` request and first-student-course behavior unchanged outside preview mode. Reset course-owned state before a new preview request and discard stale responses.

- [x] **Step 4: Implement validated preview routing in `App`**

Read query parameters through React Router, validate the requested ID against `staffCourses` using `AUTHOR_ROLES`, and pass only a matched membership into `StudentWorkspace`. Do not default to `staffCourses[0]`. Extend `StaffHome` with a concise explanation when a requested preview is invalid or unavailable.

- [x] **Step 5: Write failing tutor and write-suppression tests**

Add tests proving that, in preview mode:

- an empty homework response still renders an enabled New conversation action and GET/POST tutor calls use the requested course ID;
- creating and sending a tutor chat follows the existing conversation owner flow;
- selecting a visible homework section sends `kind: "section"` with the preview course and section IDs;
- Submit, self-assessment, and response-feedback controls are absent and their write endpoints are never called;
- the persistent Student view notice and return-to-console action are present.

- [x] **Step 6: Run the preview interaction tests and verify they fail**

Run: `cd apps/web && npx vitest run src/client/App.test.tsx src/client/StudentNavigation.test.tsx`

Expected: FAIL because preview-specific rendering and zero-homework course context are absent.

- [x] **Step 7: Implement preview presentation and behavior**

Thread `isInstructorPreview` through `StudentWorkspace`/`StudentApp`. Render the persistent notice and exit action; keep Tutor Chats and section chat enabled; omit Submit, self-assessment, and response-feedback wiring. Preserve restart for the instructor’s own teacher-test conversation. Reuse `instructorConsoleUrl()` for the exit destination.

- [x] **Step 8: Run Task 3 tests**

Run: `npm test --workspace=llteacher-web -- --run src/client/App.test.tsx src/client/StudentNavigation.test.tsx src/client/hooks/useStudentHomework.test.ts src/client/hooks/useTutorConversations.test.ts`

Expected: all selected tests pass, including ordinary student regressions.

- [x] **Step 9: Commit Task 3**

```bash
git add apps/web/src/client/components/AccountShell.tsx apps/web/src/client/components/account.css apps/web/src/client/hooks/useStudentHomework.ts apps/web/src/client/hooks/useStudentHomework.test.ts apps/web/src/client/App.tsx apps/web/src/client/App.test.tsx apps/web/src/client/StudentNavigation.test.tsx packages/ui/styles.css
git commit -m "feat(web): add instructor student view"
```

### Task 4: Update product documentation and run end-to-end verification

**Files:**
- Modify: `apps/web/README.md`
- Modify: `docs/architecture/admin-console.md`
- Modify: `docs/design-system/components.md`
- Modify: `knowledge/architecture/admin-console.md`

**Interfaces:**
- Consumes: the completed cross-app flow from Tasks 1–3.
- Produces: documentation of instructor-only markers, the Student view deep link, preview data boundaries, and instructor-owned tutor/teacher-test conversations.

- [x] **Step 1: Update current-state documentation**

Document the console launch action and marker semantics, the student app’s instructor preview entry/exit behavior, exact role/course validation, and the deliberate exclusion of preview activity from student submissions and assessments. Replace the README sentence that says staff-only accounts cannot fetch student homework with the new preview behavior.

- [x] **Step 2: Record durable project memory**

Use the repository `okf-memory` skill to update the admin-console/auth decision entries with the accepted “preview as self, never impersonate” boundary and sources pointing to the updated docs.

- [x] **Step 3: Run focused validation**

Run: `npm run typecheck && npm run lint:design-system && npm test --workspace=llteacher-admin && npm test --workspace=llteacher-web -- --force`

Expected: typecheck/lint succeed; admin and web test summaries report zero failures. Without `DATABASE_URL`, explicitly report the repository/database test count as skipped.

- [x] **Step 4: Run the repository gate**

Run: `pixi run verify`

Expected: pre-commit, OKF validation, skill-eval smoke checks, and all workspace typechecks pass.

- [x] **Step 5: Perform a manual browser smoke test**

Verify at desktop and mobile widths: marker readability in expanded/collapsed admin navigation; selected-course deep link; persistent preview notice; empty-course tutor creation; tutor send/stream/retry; homework section teacher-test chat; no Submit/self-assessment/feedback controls; return to the instructor console; no horizontal overflow or console errors.

- [x] **Step 6: Commit documentation and memory**

```bash
git add apps/web/README.md docs/architecture/admin-console.md docs/design-system/components.md knowledge/architecture/admin-console.md knowledge/log.md
git commit -m "docs: explain instructor student view"
```
