import { GetBucketVersioningCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";
import { recoverKnowledge } from "../src/server/knowledge/recovery";
import { KnowledgePersistenceError, knowledgeManifestKey, knowledgeSnapshotKey } from "../src/server/knowledge/persistence-format";
import { isMissingS3Object, type ObjectStore } from "../src/server/storage/objectStore";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const flags = new Map<string, string>();
  let apply = false;
  let stopped = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--writer-stopped") { stopped = true; continue; }
    if (!["--bucket", "--course", "--version", "--format"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--") || flags.has(arg)) throw new Error("Invalid arguments; see docs/knowledge-recovery.md");
    flags.set(arg, args[++index]);
  }
  const bucket = flags.get("--bucket");
  const courseId = flags.get("--course")?.toLowerCase();
  const version = flags.get("--version");
  const format = flags.get("--format") ?? "manifest";
  if (!bucket || !courseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(courseId) || !version || version === "null" || !["manifest", "legacy"].includes(format)) throw new Error("Required: --bucket BUCKET --course UUID --version VERSION_ID [--format manifest|legacy] [--apply --writer-stopped]");
  if (apply && !stopped) throw new Error("Stop all application writers, then pass --writer-stopped with --apply");
  const client = new S3Client({ region: process.env.AWS_REGION ?? "us-west-2" });
  const key = format === "manifest" ? knowledgeManifestKey(courseId) : knowledgeSnapshotKey(courseId);
  const selected = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
  if (!selected.Body) throw new Error("Selected version has no body");
  const source = Uint8Array.from(await selected.Body.transformToByteArray()).buffer;
  if (apply) {
    const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== "Enabled") throw new Error("Recovery requires S3 versioning enabled so the previous current version is retained");
  }
  const manifestKey = knowledgeManifestKey(courseId);
  let currentEtag: string | undefined;
  let observedCurrent = false;
  const storage: ObjectStore = {
    async get(objectKey) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        if (objectKey === manifestKey) { currentEtag = result.ETag; observedCurrent = true; }
        if (!result.Body) throw new Error("S3 object has no body");
        return Uint8Array.from(await result.Body.transformToByteArray()).buffer;
      } catch (error) {
        if (!await isMissingS3Object(client, bucket, objectKey, error)) throw error;
        if (objectKey === manifestKey) { currentEtag = undefined; observedCurrent = true; }
        return null;
      }
    },
    async put(objectKey, body, options) {
      if (objectKey === manifestKey && !observedCurrent) throw new Error("Current manifest was not checked");
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: objectKey, Body: new Uint8Array(body), ContentType: options.contentType,
        ...(objectKey === manifestKey && currentEtag ? { IfMatch: currentEtag } : { IfNoneMatch: "*" }),
      }));
    },
    async delete() { throw new Error("Recovery never deletes objects"); },
    async head() { throw new Error("Recovery does not use HEAD"); },
  };
  const result = await recoverKnowledge({ storage, courseId, source, format: format as "manifest" | "legacy", apply });
  console.log(JSON.stringify({ event: "knowledge_recovery", courseId, key, version, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify(error instanceof KnowledgePersistenceError
      ? { event: "knowledge_recovery_failed", code: error.code, courseId: error.courseId, key: error.key }
      : { event: "knowledge_recovery_failed", error: error instanceof Error && !('$metadata' in error) ? error.message : "S3 request failed; verify operator permissions, version and conditional write" }));
    process.exitCode = 1;
  });
}
