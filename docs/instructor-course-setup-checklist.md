# Instructor Course Setup and Launch Checklist

Use this checklist after a superadmin assigns you to an LLTeacher course. It takes the course from an empty shell to a launch-ready learning environment with students, teaching assistants, course knowledge, tutor configurations, and homework.

**Updated:** October 15, 2026

> [!CALLOUT] ⚠️
>
> **Instructors do not create course shells.** A superadmin must create the course and assign you first. If your course does not appear in the course switcher, contact a superadmin.

# Course setup sequence

- [ ] Open the instructor console and select the correct course in the top navigation.

- [ ] Confirm the course title, code, and term before adding people or content.

- [ ] Add or import the student roster.

- [ ] Add teaching assistants and set their permissions.

- [ ] Upload and verify the course knowledge base.

- [ ] Create and test at least one tutor configuration.

- [ ] Create homework as a draft, review it, and publish or schedule it.

- [ ] Complete the launch checks at the end of this guide.

# Add students to the roster

Choose CSV, Canvas, or both. The roster uses one membership per person per course, so matching imports do not create duplicate enrollments.

## Import students from CSV

- [ ] Open **Roster**.

- [ ] Select **Download CSV template** if you do not already have a correctly formatted file.

- [ ] Include an `email` column. `name` and `role` are optional; role defaults to `student`.

- [ ] Select **Import from CSV** and choose a `.csv` file.

- [ ] Review every row in the preview. Nothing is written during preview.

- [ ] Correct invalid emails, disallowed domains, duplicate rows, or role conflicts.

- [ ] Select **Import** to commit the rows.

- [ ] Review the final per-row results and confirm the roster refreshed.

Students who have not signed in appear as invited or pending. They claim the pending account by signing in with the same email address.

## Connect Canvas and sync the roster

- [ ] Open **Canvas**.

- [ ] Under **My Canvas account**, enter your Canvas base URL and personal API token.

- [ ] Confirm that token validation succeeds.

- [ ] Under **This course’s Canvas connection**, select and link the correct Canvas course.

- [ ] Run **Sync from Canvas**, or return to **Roster** and select **Import from Canvas**.

- [ ] Review the counts for added, updated, and removed memberships, plus any row errors.

- [ ] Confirm the resulting roster in LLTeacher.

Canvas sync imports active or invited enrollments and maps Canvas teachers, TAs, students, observers, and designers to LLTeacher roles. It does not import assignments, files, modules, knowledge materials, or grades.

## What happens when CSV and Canvas overlap

| Situation | Result |
|---|---|
| CSV adds a student, then Canvas returns the same email as a student | No duplicate is created. The existing membership is linked to the Canvas enrollment. |
| A manually added person is not present in Canvas | They remain on the course because Canvas only removes memberships that a previous Canvas sync marked as Canvas-managed. |
| Canvas returns the same email under a different role from the manual membership | LLTeacher reports a role conflict and preserves the manually assigned role. Resolve the role intentionally instead of relying on sync to overwrite it. |
| A later Canvas sync changes the role of a Canvas-managed membership | Canvas updates the role. If a TA is demoted, TA capability grants are cleared. |
| A later Canvas sync no longer includes a Canvas-managed enrollment | The membership is soft-removed from the course. Existing submitted work is retained. |
| Canvas fails while fetching the roster | No partial roster is written. Resolve the Canvas error and retry. |

> [!CALLOUT] 💡
>
> **Example:** If you import one student through CSV and then sync Canvas, the student is not overwritten or duplicated when the email and role match. The existing row becomes Canvas-managed. From that point forward, Canvas can update that membership or remove it when the Canvas enrollment disappears.

# Add teaching assistants

- [ ] Open **TA permissions** for the correct course.

- [ ] Select **Add teaching assistants**.

- [ ] Enter UW NetIDs only—the part before `@uw.edu`. You may paste a list separated by spaces, commas, semicolons, tabs, or new lines.

- [ ] Add no more than 100 NetIDs in one request.

- [ ] Review the result for every NetID and correct any invalid or conflicting entry.

- [ ] For each TA, decide whether to allow **Model solutions**.

- [ ] For each TA, decide whether to allow **Unreleased homeworks**.

- [ ] Confirm invited TAs sign in with their UW NetID.

TAs can read the submissions dashboard and student answers by default. They cannot author course content, view model solutions, or open draft, scheduled, or hidden homework unless you explicitly grant those capabilities for this course. Re-adding a removed TA restores the membership with both optional capabilities turned off.

# Build and maintain the knowledge base

## Upload course material

- [ ] Open **Knowledge**.

- [ ] Select **Upload files** for individual files or **More actions** → **Upload folder** to preserve a folder structure.

- [ ] Use supported file types: PDF, DOCX, PPTX, TXT, Markdown, VTT, or SRT.

- [ ] Keep each file at or below 25 MB.

- [ ] Wait for uploads to move from pending or processing to ready.

- [ ] Use **Needs attention** to retry failed extractions.

- [ ] Search for several course-specific terms and open the resulting documents to verify that extraction and indexing worked.

## Update existing knowledge

- [ ] Open the indexed document you want to change.

- [ ] Select **Edit** and update the Markdown body.

- [ ] Use **Preview** to check headings, lists, tables, equations, and links.

- [ ] Select **Save**. The saved body becomes the searchable content the tutor uses.

- [ ] If useful, run **Clean up Markdown**, review the proposed changes carefully, and apply only after checking wording, numbers, tables, and equations.

- [ ] Search for the changed information to verify the update.

Do not upload a file with the same name expecting it to overwrite an existing document. A new upload receives its own material record and may create a second document with a numbered path. To replace a source file completely, delete the old document and its original upload, then upload the replacement. For small or focused corrections, edit the indexed document directly.

## Tell the tutor how to use course knowledge

- [ ] At the bottom of **Knowledge**, open **How the tutor uses this knowledge base**.

- [ ] Review the current built-in, organization, or course-specific instruction.

- [ ] Add a course-specific instruction only when the default does not fit the course.

- [ ] Save the instruction.

- [ ] Confirm each tutor configuration that should use knowledge has **Let the tutor search the course knowledge base** enabled.

Turning knowledge access off in a tutor configuration creates a closed-book tutor. The tutor is not told that the knowledge base exists.

# Create tutor configurations

- [ ] Open **Tutor configurations** or **LLM configs**.

- [ ] Review the existing shared and course-specific configurations.

- [ ] Select **New configuration**, or copy a shared configuration to adapt it for this course.

- [ ] Give the configuration a descriptive name such as `Socratic homework tutor`.

- [ ] Use the platform gateway and select the intended model.

- [ ] Set **Consistency** and the **Answer length limit**.

- [ ] Write or import the base prompt that defines the tutor’s role and voice.

- [ ] Optionally choose one active configuration as a fallback for failures before an answer begins.

- [ ] Keep the configuration **Active** if it should be selectable for new homework.

- [ ] Enable or disable course knowledge access intentionally.

- [ ] Select only the subject-figure packs that fit the course.

- [ ] Create the configuration, reopen it, and use **Test this configuration** before assigning it to students.

Shared configurations are managed by organization admins. If you cannot edit one, use **Copy** to create a course-owned version. Configurations are deactivated rather than deleted because existing homework may reference them.

# Create and publish homework

- [ ] Open **Homeworks** and select **New homework**.

- [ ] Enter a title, description, and required due date.

- [ ] Choose a tutor configuration, or leave the course or organization default selected.

- [ ] Start with **Save as draft** while authoring and testing.

- [ ] Leave **Hidden** off unless the homework must be removed from student view regardless of publication state.

- [ ] Leave **Expires at** empty unless students should lose access entirely after that time.

- [ ] Add at least one section.

- [ ] For every section, choose **Conversation** or **Question**.

- [ ] Write the section content in Markdown and review its rendered preview.

- [ ] Add an optional model solution for graders with the solutions capability.

- [ ] Add pre-section and post-section progress-widget prompts when self-assessment is needed.

- [ ] Select **Save** and correct any validation or save errors.

- [ ] Reopen the saved draft and verify the title, due date, tutor configuration, sections, solutions, and visibility.

- [ ] Choose **Publish now** or **Schedule for later** when the homework is ready.

The due date marks work as past due but does not hide it. **Expires at** hides the homework entirely after the selected time, including submitted work and tutor conversations, so use it only when access must be withdrawn.

# Test the course before launch

- [ ] Confirm the intended students appear in **Roster** with expected roles and statuses.

- [ ] Confirm every TA appears under **TA permissions** with only the capabilities they need.

- [ ] Search the knowledge base for representative concepts and verify the correct documents appear.

- [ ] Test each tutor configuration with a realistic student question.

- [ ] Confirm a knowledge-enabled configuration can answer from uploaded course material.

- [ ] Confirm a closed-book configuration does not use course knowledge.

- [ ] Review homework publication, release time, due date, hidden state, and expiration separately.

- [ ] Confirm every homework section has the correct type, prompt, and optional solution.

- [ ] If Canvas is connected, run a final sync and review added, updated, removed, and failed rows.

- [ ] Ask a test student or approved test account to confirm the student-facing course and homework experience.

# Ongoing course maintenance

- [ ] Review invited students and TAs who have not signed in.

- [ ] Run Canvas sync when the Canvas roster changes; synchronization is not automatic.

- [ ] Review sync errors instead of assuming every row changed.

- [ ] Edit indexed knowledge documents for focused corrections; delete and re-upload only for full source replacement.

- [ ] Search the knowledge base after every material update.

- [ ] Test tutor configurations after changing prompts, models, knowledge access, fallbacks, or limits.

- [ ] Deactivate retired tutor configurations only after confirming no new homework should use them.

- [ ] Review homework visibility before and after scheduled releases.

- [ ] Remove departed TAs or students from the course while preserving their submitted work.
