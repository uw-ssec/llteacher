# LLTeacher 0.4

LLTeacher is an AI tutoring platform for professors and students
at the University of Washington (UW). It brings course materials, homework, and
AI tutor conversations into one learning environment. Professors configure tutors
to support their teaching goals, give students guided help with course content,
and review their work. Students can ask course questions and work through
assignments with a tutor configured by their instructor.

**Open LLTeacher:** [Student app](https://llteacher.org/) ·
[Instructor / admin app](https://llteacher.org/admin/)

**New to LLTeacher?** Start with [Getting access](#getting-access), then follow
the [Instructor Course Setup and Launch Checklist](./docs/instructor-course-setup-checklist.md).

## What you can do with LLTeacher

- **Teach with your course materials.** Upload lecture notes, slides, readings,
  and other resources for tutors to search when course knowledge is enabled.
- **Configure AI tutors for your course.** Choose a model, write instructions,
  adjust response settings, and decide whether a tutor can use course knowledge.
- **Create homework and assignments.** Build assignments with conversation and
  question sections, review drafts, and publish immediately or schedule a release.
- **Bring your class together.** Import students from Canvas or CSV, add teaching
  assistants, and manage their course permissions.
- **Review and improve the learning experience.** Review student submissions and
  conversations, test tutor configurations, and preview your course as students
  see it.

## Getting access

UW professors interested in using LLTeacher should email the
**Scientific Software Engineering Center (SSEC)** at
[ssec@uw.edu](mailto:ssec@uw.edu) to request access and be added to the platform.
Include your UW email address and the course or teaching use case you would
like to support. You can also visit SSEC’s
[Get Involved and contact information page](https://escience.washington.edu/get-involved-with-ssec/).

SSEC coordinates instructor access and course assignment. A platform
administrator creates your course or adds you to an existing one. Once access
is ready, sign in with the same institutional email used during onboarding and
confirm that your course appears in the instructor console.

If your course does not appear, contact SSEC to check your course assignment.

## Set up your first course

1. **Get access and a course assignment through SSEC.** Course creation is
   handled by a platform administrator.
2. **Add your students.** Connect your Canvas course and import its roster, or
   import students with a CSV file. Add TAs and choose their permissions.
3. **Add your course materials.** Upload resources and verify that the extracted
   content is searchable.
4. **Configure and test your AI tutor.** Choose the model, instructions, response
   settings, and access to course knowledge.
5. **Create your first assignment.** Add homework sections, review the draft,
   and publish or schedule it when ready.
6. **Check the student experience.** Use Student view and test the tutor before
   launching the course.

The [Instructor Course Setup and Launch Checklist](./docs/instructor-course-setup-checklist.md)
walks through the complete process and the checks to run before students begin.

## Guides for professors

Use these guides when setting up a course or updating it during the term.
LLTeacher calls its assignments **homework** and its configurable AI tutors
**tutor configurations** in the teaching console.

| I want to… | Guide |
| --- | --- |
| Have a course created or join an existing course | [Course creation and instructor onboarding](./docs/superadmin-instructor-onboarding.md#choose-the-correct-workflow) — administrator steps, coordinated through SSEC |
| Link my Canvas course and import students | [Connect Canvas and sync the roster](./docs/instructor-course-setup-checklist.md#connect-canvas-and-sync-the-roster) |
| Import students without Canvas | [Import students from CSV](./docs/instructor-course-setup-checklist.md#import-students-from-csv) |
| Add TAs and set their permissions | [Add teaching assistants](./docs/instructor-course-setup-checklist.md#add-teaching-assistants) |
| Upload or update course materials | [Build and maintain the knowledge base](./docs/instructor-course-setup-checklist.md#build-and-maintain-the-knowledge-base) |
| Configure AI tutors and agents | [Create tutor configurations](./docs/instructor-course-setup-checklist.md#create-tutor-configurations) |
| Create assignments and publish homework | [Create and publish homework](./docs/instructor-course-setup-checklist.md#create-and-publish-homework) |
| Check that my course is ready | [Test the course before launch](./docs/instructor-course-setup-checklist.md#test-the-course-before-launch) |
| Update my course throughout the term | [Ongoing course maintenance](./docs/instructor-course-setup-checklist.md#ongoing-course-maintenance) |

## Using Canvas with LLTeacher

Canvas is optional: you can use LLTeacher with a CSV-managed roster. When you
connect Canvas, use your own Canvas account token and select the course you
want to link.

Canvas integration imports and updates **course enrollments**. It does not
import assignments, files, course materials, or grades. Create homework and
upload teaching materials in LLTeacher using the guides above.

Roster synchronization is manual. Run **Sync from Canvas** when enrollments
change, then review the results. See
[Canvas setup and roster sync](./docs/instructor-course-setup-checklist.md#connect-canvas-and-sync-the-roster)
for the steps.

## For developers and contributors

For local setup, architecture, testing, and infrastructure, see the
[Developer README](./docs/developer-readme.md). Contribution guidance is in
[CONTRIBUTING.md](./CONTRIBUTING.md), and the
[documentation index](./docs/README.md) links to additional technical references.
