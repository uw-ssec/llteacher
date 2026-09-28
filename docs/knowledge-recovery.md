# Knowledge persistence and operator recovery

Production uses one application writer. Do not run concurrent ECS tasks, local
processes, recovery commands, or rolling replacements against the same course.
The shared task role can access every course prefix; prefixes organize data but
do not provide per-course IAM isolation.

Every course has `courses/<UUID>/knowledge/manifest.json` and immutable content
objects at `courses/<UUID>/knowledge/blobs/<sha256>`. Mutations upload changed
content and publish the manifest last, returning success only after publication.
Unchanged local files reuse hashes when inode, device, size, nanosecond mtime and
ctime all match. This relies on the private local cache and single writer; it is
not a distributed filesystem change detector. Original bodies and deletions are
represented in the manifest. Previous manifests and unreferenced blobs remain
available; do not manually clean up blobs referenced by retained versions.

Existing `snapshot.zip` is read in a worker with expansion, path, symlink and CRC
checks. The next successful mutation creates the manifest. The ZIP is retained.
An absent remote snapshot with nonempty local files fails closed for migration.
Do not delete those files to bypass the failure; preserve and migrate the known
source before restarting with a fresh local cache.

Corruption fails closed with `KnowledgePersistenceError`, a fixed diagnostic
code, course UUID and object key. Codes distinguish `KNOWLEDGE_CORRUPT_MANIFEST`,
`KNOWLEDGE_CORRUPT_BLOB` and `KNOWLEDGE_CORRUPT_LEGACY`. Diagnostics omit document
names, content and credentials. Network/authentication/server errors propagate
as storage errors, not corruption. The application never selects an older
version or initializes an empty replacement after corruption.

## Recover an explicitly selected S3 version

Run this **from an authenticated operator checkout**, not inside the production
image. Use an operator role scoped to this bucket/course with `s3:ListBucketVersions`
and `s3:ListBucket` on the bucket, each restricted by the `s3:prefix` condition
`courses/<UUID>/knowledge/*`, `s3:GetBucketVersioning` on the bucket,
and `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject` on
`courses/<UUID>/knowledge/*`. The application role does not need version reads.
Use the normal AWS credential chain; never put credentials in command arguments.

A missing current object can return HTTP 403 when listing permission is scoped
by prefix. Runtime and recovery explicitly probe that exact key with
`ListObjectsV2` (`Prefix` equal to the full key, `MaxKeys=1`). Only a complete,
valid result without the exact key establishes absence; a listed prefix neighbor
is not the object itself. Existing objects, denied listings and inconclusive
responses fail closed. Failure to read the explicitly selected source version
always stops recovery and never invokes this current-object existence fallback.

1. Stop the ECS service and verify every application writer has stopped. Preserve
   the local course directory for investigation. Keep S3 bucket versioning enabled.
2. List versions for the exact manifest key and select a known-good version ID:

   ```sh
   aws s3api list-object-versions --bucket BUCKET --prefix courses/COURSE_UUID/knowledge/manifest.json
   ```

   For a legacy course use the exact `snapshot.zip` key and `--format legacy`.
   A delete marker is not a data version. Do not use the `null` version.
3. Validate the selected version and all its referenced blobs without writing:

   ```sh
   npx tsx apps/web/scripts/recover-knowledge.ts --bucket BUCKET --course COURSE_UUID --version VERSION_ID
   ```

   If a blob fails validation, this command stops. Use S3 version history to
   inspect that **exact reported blob key** and restore an explicitly selected
   known-good version of that blob using operator tools, then repeat validation.
   Keep all versions. Do not substitute empty files or remove manifest entries.
4. Apply the same selected version while the service remains stopped:

   ```sh
   npx tsx apps/web/scripts/recover-knowledge.ts --bucket BUCKET --course COURSE_UUID --version VERSION_ID --apply --writer-stopped
   ```

   The command revalidates, copies the current raw manifest (even if corrupt) to
   a new `knowledge/recovery/<UUID>.json` object, and publishes the selected
   contents as a new manifest version. Publication uses the current ETag as a
   condition, or requires absence if no current manifest exists. A concurrent
   change therefore fails instead of being overwritten. Legacy recovery uploads
   immutable blobs and retains the selected ZIP and its history.
5. Start one fresh application task so it reloads durable state. Confirm the
   expected concepts, originals and deletions. Keep the recorded source version,
   backup key and preserved local files until recovery is accepted.

An interrupted recovery can leave additional backups/blobs, which are harmless.
Retry validation and apply with the same explicit source version. The command
never deletes S3 objects or old versions and does not automatically resume writers.
