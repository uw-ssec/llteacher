import { describe, it, expect } from "vitest";
import { s3ObjectStore, StorageError } from "./objectStore";

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT;

/** Gated like the DB suites: without the endpoint this SKIPS, and a skip is
 *  not a pass. Run it with S3_TEST_ENDPOINT=http://localhost:9000 against the
 *  MinIO container. */
describe.skipIf(!S3_ENDPOINT)("s3ObjectStore against a real S3 endpoint", () => {
  const store = () =>
    s3ObjectStore({
      endpoint: S3_ENDPOINT!,
      bucket: "llteacher-materials",
      accessKeyId: process.env.S3_TEST_KEY ?? "minioadmin",
      secretAccessKey: process.env.S3_TEST_SECRET ?? "minioadmin",
    });

  it("signs a PUT that the server accepts, and reads it back byte-identically", async () => {
    const s = store();
    const key = `courses/c/materials/m/round-trip-${crypto.randomUUID()}.txt`;
    const body = new TextEncoder().encode("hello storage").buffer;

    await s.put(key, body, { contentType: "text/plain" });
    const read = await s.get(key);

    expect(read).not.toBeNull();
    expect(new TextDecoder().decode(read!)).toBe("hello storage");
  });

  it("reports size and content type via HEAD", async () => {
    const s = store();
    const key = `courses/c/materials/m/head-${crypto.randomUUID()}.txt`;
    await s.put(key, new TextEncoder().encode("12345").buffer, { contentType: "text/plain" });

    const meta = await s.head(key);
    expect(meta?.size).toBe(5);
    expect(meta?.contentType).toContain("text/plain");
  });

  it("returns null rather than throwing for a key that does not exist", async () => {
    const s = store();
    expect(await s.get(`courses/c/materials/m/absent-${crypto.randomUUID()}`)).toBeNull();
    expect(await s.head(`courses/c/materials/m/absent-${crypto.randomUUID()}`)).toBeNull();
  });

  it("deletes idempotently, including a key that was never there", async () => {
    const s = store();
    const key = `courses/c/materials/m/del-${crypto.randomUUID()}.txt`;
    await s.put(key, new ArrayBuffer(1), {});
    await s.delete(key);
    await s.delete(key);
    expect(await s.head(key)).toBeNull();
  });

  it("round-trips a key containing characters that need URL encoding", async () => {
    const s = store();
    const key = `courses/c/materials/m/a b+c${crypto.randomUUID()}.txt`;
    await s.put(key, new TextEncoder().encode("x").buffer, {});
    expect(await s.get(key)).not.toBeNull();
  });

  it("throws a StorageError carrying the real status when the bucket does not exist", async () => {
    const s = s3ObjectStore({
      endpoint: S3_ENDPOINT!,
      bucket: "llteacher-materials-does-not-exist",
      accessKeyId: process.env.S3_TEST_KEY ?? "minioadmin",
      secretAccessKey: process.env.S3_TEST_SECRET ?? "minioadmin",
    });
    const key = `courses/c/materials/m/no-bucket-${crypto.randomUUID()}.txt`;

    let error: unknown;
    try {
      await s.put(key, new TextEncoder().encode("x").buffer, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).operation).toBe("put");
    expect((error as StorageError).status).toBe(404);
  });
});
