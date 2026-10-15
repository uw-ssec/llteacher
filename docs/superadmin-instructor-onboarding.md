# Superadmin Guide to Onboarding Instructors

Use this guide to give an instructor the right LLTeacher access and confirm that they can reach the intended course. LLTeacher separates **platform instructor access** from **course membership**: platform access lets someone enter the instructor console, while course membership gives them authority over a specific course.

**Updated:** October 15, 2026

> [!CALLOUT] ✅
>
> **Fastest path for a new course:** Open **Course Setup**, create the course with the instructor’s institutional email, and ask the instructor to sign in with that exact address. This single workflow grants platform access and assigns the course.

# Before you begin

Confirm the following before onboarding an instructor:

- You are signed in to the instructor console as a configured superadmin.

- The institution has already been created in LLTeacher.

- You have the instructor’s exact institutional email address.

- The email domain is allowed by the institution’s sign-in policy.

- You know whether the instructor needs a new course, an existing course, or console access before any course is assigned.

LLTeacher does not create or modify WorkOS organizations during these workflows.

# Choose the correct workflow

| Instructor need | Where to go | Result |
|---|---|---|
| A new course | **Course Setup** | Creates an empty course shell, grants platform access, and assigns the instructor |
| An existing course | **Course Setup** → **All courses** | Grants platform access if needed and adds the instructor to that course |
| Console access before a course exists | **Add Instructor** | Grants platform access only; the instructor has no course authority yet |
| Remove access from one course | **Course Setup** → **Edit instructors** | Removes only that course membership |
| Remove all instructor access | **Add Instructor** → **All instructors** → **Remove** | Revokes platform access and all course memberships, subject to safeguards |

# Create a new course and assign its first instructor

1. Open **Course Setup** from the superadmin sidebar.

2. Enter the instructor’s institutional email.

3. Enter the course title, course code, and term.

4. Select **Create course**.

5. Confirm that the success message names the course and instructor.

6. In **All courses**, confirm that the new course lists the instructor’s email.

LLTeacher performs the identity, access grant, course creation, and course assignment together. If the operation fails, retry after correcting the displayed error; it should not leave a partially created onboarding record.

A course with the same code and term cannot be created twice, even if capitalization differs.

# Add an instructor to an existing course

1. Open **Course Setup**.

2. Find the course under **All courses** and verify its code and term.

3. Select **Add instructor** in that course’s row.

4. Enter the instructor’s institutional email.

5. Select **Add instructor** again to submit.

6. Confirm that the instructor appears in the course’s **Instructors** column.

Existing instructors remain assigned. Repeating the same assignment is safe, and re-adding someone whose membership was previously removed restores that membership.

# Grant instructor access before assigning a course

Use this workflow only when the person needs to enter the instructor console before a course is ready.

1. Open **Add Instructor** from the superadmin sidebar.

2. Enter the instructor’s institutional email.

3. Select **Grant instructor access**.

4. Under **All instructors**, confirm that the person appears as **Pending** or **Signed in**.

5. Later, use **Course Setup** to assign the instructor to a course.

A platform grant alone does not let the instructor view or manage any course.

# Verify the onboarding

After completing the appropriate workflow:

- In **Add Instructor**, check the instructor’s status, assigned-course count, course codes, and terms.

- In **Course Setup**, confirm the instructor’s email is listed on each intended course.

- Ask the instructor to sign in with the exact email that was entered during onboarding.

- If the instructor was already signed in, ask them to refresh the console.

- For multiple courses, ask them to use the course switcher in the top navigation and confirm each expected course appears.

A newly created or assigned course is ready for use without Canvas.

# Hand off course setup to the instructor

Once the instructor can open the course, they can complete the course-specific setup:

1. Add students manually or with the roster CSV tools.

2. Optionally open **Canvas**, save their own Canvas token under **My Canvas account**, link the selected course, and run **Sync from Canvas**.

3. Add TAs and configure course-specific permissions under **TA permissions**.

4. Upload course materials under **Knowledge**.

5. Configure the course’s LLM settings and create homework content.

Canvas is optional. Canvas roster sync imports enrollments only; it does not import assignments, files, modules, knowledge materials, or grades. One instructor-owned Canvas token can be reused across courses that instructor teaches.

# Correct or remove instructor access

## Remove an instructor from one course

1. Open **Course Setup**.

2. Find the course and select **Edit instructors**.

3. Select **Remove** beside the instructor. Use **Undo** if you selected the wrong person.

4. Select **Save changes**.

This removes access to that course only. The instructor keeps platform access and any other course assignments. A course may temporarily have no instructors, so verify the remaining assignments before saving.

## Revoke all instructor access

1. Open **Add Instructor**.

2. Find the person under **All instructors**.

3. Select **Remove**.

4. Read the confirmation carefully, then confirm only if you intend to revoke platform access and remove every course membership.

LLTeacher blocks this action if it would leave any assigned course without another active instructor or admin. If blocked, first assign a replacement through **Course Setup**, then retry the platform-wide removal.

# Troubleshooting

| Problem | What to check |
|---|---|
| Email is rejected | Confirm the address is well formed and uses an allowed institutional domain |
| Instructor is listed as Pending | They have not yet signed in with the exact granted email |
| Instructor can enter the console but sees no course | They have platform access but no active course membership; add them through **Course Setup** |
| Instructor cannot see a newly assigned course | Confirm the email and assignment, then have them refresh or sign out and back in |
| Course creation reports a duplicate | Check **All courses** for the same course code and term, ignoring capitalization |
| Platform-wide removal is blocked | The instructor is the only active instructor or admin on at least one named course; assign a replacement first |
| A request times out | Reload the relevant list before retrying so you do not repeat an operation that already succeeded |

# Superadmin completion checklist

- [ ] The instructor’s exact institutional email is recorded.

- [ ] Platform instructor access is visible under **All instructors**.

- [ ] Every intended course lists the instructor under **All courses**.

- [ ] The instructor has signed in successfully.

- [ ] The instructor can select and open each assigned course.

- [ ] The instructor understands that Canvas is optional and uses their own token.

- [ ] Any departing instructor was removed at the correct scope: one course or the entire platform.
