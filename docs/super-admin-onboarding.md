# Super-admin onboarding

This deployment owns one local institution. WorkOS continues to handle sign-in only; these steps do not create or change anything in WorkOS.

## First deployment setup

Before starting a non-UW deployment, configure who may perform first-run setup
and which email domains may sign in before the institution row exists:

```bash
pulumi -C infra config set superAdminEmails "operator@example.edu"
pulumi -C infra config set bootstrapAllowedDomains "example.edu"
```

Both settings accept comma-separated values. Existing UW deployments retain
the current UW defaults, but a new institution should set them explicitly.
These are LLTeacher runtime settings; they do not update WorkOS.

1. Open the instructor admin portal and sign in with a configured super-admin email.
2. On **Set up your institution**, enter the institution name, URL-safe slug, and allowed sign-in domains. For UW, use a name such as `University of Washington`, slug `uw`, and domain `uw.edu`.
3. Select **Create institution**. This is a one-time action enforced by the database.

Another institution deploying this code first sets its bootstrap values above,
then follows the same screen and enters its own name, slug, and domains. There
is no UW organization baked into WorkOS or created automatically.

## Create a course and hand it to an instructor

1. Open **Course Setup** in the super-admin sidebar.
2. Enter the instructor's institutional email, course title, course code, and term.
3. Select **Create course**.

LLTeacher creates or reuses the pending instructor identity, grants instructor-portal access, creates a new empty course shell, and adds that instructor to it in one transaction. The super admin is not added to the course.

The instructor can now sign in with the exact email entered above. Their course appears in the top navigation; instructors teaching multiple courses can switch there.

## Instructor-owned course setup

The instructor performs the remaining course work:

1. Optionally open **Canvas** and add a token under **My Canvas account**. One instructor-owned token can be reused for several courses they teach.
2. Under **This course's Canvas connection**, optionally select the Canvas course to link.
3. Run **Sync from Canvas** to import the roster. Canvas files, assignments, and course materials are not imported.
4. Open **TA permissions** to add TAs and set their course-specific capabilities.
5. Open **Knowledge** to upload course materials and manage the knowledge base.

Canvas is optional. A course without a Canvas link is a fully usable LLTeacher course; its roster can be managed with the existing manual/CSV tools.

## Legacy Canvas tokens

An older organization-owned token has no safe, unambiguous instructor owner. LLTeacher will not use it. The Canvas screen asks each instructor to reconnect with their own token, after which they can relink their courses.
