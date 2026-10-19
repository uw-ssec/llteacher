# Instructor Student View and Tutor Chat Design

This design gives instructors a clearly marked path from the instructor console into the real student workspace for one course, while keeping instructor activity separate from student records. It also makes every left-sidebar console destination visibly distinct from student-facing navigation.

## Intent and success criteria

- Every rendered left-sidebar console destination carries a visible eye-slash symbol and the accessible explanation “Only instructor viewable.”
- An instructor can open **Student view** for the course currently selected in the admin console.
- Student view renders the real student navigation and only the homework that an enrolled student can currently see: published, released, not hidden, and not expired.
- An instructor can create, resume, rename, delete, and use their own free-standing AI tutor chats in the selected course, including when the course has no visible homework.
- An instructor can open a homework section and exercise its tutor. Existing server behavior records that section conversation as `isTeacherTest`.
- Instructor preview activity never creates a student submission, self-assessment response, or section answer, and never impersonates or reads another user’s data.

## Chosen approach

Use the existing student React workspace rather than building a second preview UI in `apps/admin`. The admin console opens the web app with an explicit `view=student&courseId=<id>` deep link. The web app validates that the signed-in user is an author for that exact course before it enters preview mode.

The current student homework endpoint remains student-only. A new instructor-only, course-scoped endpoint returns the same `StudentHomeworkListResponse` shape for the selected course. Both endpoints share one repository projection so the visibility rules, section ordering, and per-owner conversation state cannot drift. The instructor endpoint still filters to student-visible homework; previewing draft or unsaved authoring state remains the separate issue #330.

Tutor conversation list/create/chat routes already authorize any active course member and scope every row to `ownerUserId`. The missing piece is stable course context: today the web client derives `courseId` from the first visible homework and redirects staff-only users to `StaffHome`. In preview mode, course context instead comes from the validated staff membership, so tutor chats work even when the homework list is empty.

## User experience

### Instructor console

Every rendered left-sidebar navigation destination—including Homeworks, Submissions, Feedback, LLM Configs, Knowledge, and role-gated destinations—shows a small Phosphor `EyeSlash` marker aligned at the far right of the row: `Homeworks … [eye-slash]`. Hovering the row or marker shows the tooltip “Only instructor viewable”; keyboard focus reveals the same tooltip, and assistive technology receives the same explanation through `aria-describedby`. The collapsed sidebar retains the destination label plus that explanation in its accessible name and native tooltip rather than relying on the icon alone.

The marker means “this destination is part of the instructor-facing console and is not shown in Student view.” It does not introduce or change authorization. Existing `authorOnly` and `superAdminOnly` filters continue to decide which destinations each signed-in staff member can see, so a TA still sees only the console pages already allowed to that role, with the marker on each visible row. The **Student view** launch action is the bridge into the student-facing workspace and therefore does not carry the marker.

The sidebar also offers **Student view** when the selected-course role is `instructor` or `admin`. Activating it opens the student app for that course. The current production deployment uses the same origin; the URL helper also maps the established local port pairs 2312→2311 and 2412→2411.

### Student view

The student workspace shows a persistent “Student view” notice identifying the selected course and explaining that activity belongs to the instructor’s test account. It provides a route back to the instructor console.

Free-standing tutor chats are fully enabled. Homework-section tutor chats use the existing section conversation path, which marks non-student owners as teacher tests. Submission, self-assessment, and response-feedback controls are omitted in preview mode so the client does not offer actions the server will reject or that could be mistaken for student work. Restarting an instructor’s own teacher-test section conversation remains available.

An invalid, missing, or unauthorized `courseId` never falls back to another membership. Staff users return to the teaching workspace with an explanatory message; students continue through the existing student flow and cannot activate instructor preview mode by editing the URL.

## Authorization and data flow

1. `apps/admin` builds a deep link for the selected course only when `canAuthor` is true.
2. `apps/web` reads the requested course ID and matches it against the authenticated profile’s course memberships using the shared `AUTHOR_ROLES` definition.
3. The web client requests `GET /api/courses/:courseId/student-view/homeworks`.
4. The server applies `requireInstructorOf`, re-checks the exact course in the handler, and passes a `CourseScope` to the repository.
5. The repository returns student-visible homework plus only the caller’s own section-conversation state.
6. Tutor list/create/chat calls continue using the existing course-member and owner checks.

No schema or migration is required.

## Error handling

- An unauthorized or malformed preview course is rejected without revealing whether unrelated courses exist.
- A failed preview homework request uses the existing homework load-error state and retry behavior.
- An empty homework list is a valid state; Tutor Chats stays enabled because it receives course context independently.
- Tutor API failures retain the current inline error, retry, and draft-preservation behavior.

## Testing

- Admin component tests cover the eye-slash marker on every rendered navigation destination, its hover/focus tooltip and accessible description, collapsed accessible names, unchanged role gating, and the unmarked Student view action.
- URL-helper tests cover production same-origin URLs, both local port pairs, and encoded course IDs.
- Route tests cover instructor success, exact-course denial, student denial, and repository failure.
- Database-backed repository tests prove exact-course isolation, student visibility filtering, and caller-owned teacher-test state.
- Web client tests cover valid and invalid preview deep links, zero-homework tutor availability, teacher-test section chat, omitted submission/self-assessment controls, and ordinary student regression behavior.
- The final check runs targeted tests, the full workspace test suite, typecheck, design-system lint, and the repository verification gate.

## Non-goals

- Impersonating a named student or reading another user’s private progress.
- Creating instructor submissions, section answers, or self-assessment responses.
- Previewing unsaved form state, drafts, scheduled work, hidden work, or expired work; that remains issue #330.
- Adding a student course switcher or changing issue #70’s scope.
- Changing quotas, LLM configuration resolution, or conversation persistence.
