import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3ObjectStore } from "./objectStore";

const key = "courses/11111111-2222-4333-8444-555555555555/knowledge/manifest.json";
const forbidden = { $metadata: { httpStatusCode: 403 } };
afterEach(() => vi.restoreAllMocks());

describe.each(["get", "head"] as const)("S3 %s missing-key discrimination after 403", operation => {
  it.each([
    { IsTruncated: false, KeyCount: 0 },
    { IsTruncated: false, KeyCount: 1, Contents: [{ Key: `${key}.backup` }] },
  ])("returns null only when a complete exact-prefix listing proves absence", async listing => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) throw forbidden;
      if (command instanceof ListObjectsV2Command) {
        expect(command.input).toEqual({ Bucket: "test-bucket", Prefix: key, MaxKeys: 1 });
        return listing;
      }
      throw new Error("unexpected request");
    });
    expect(await s3ObjectStore({ bucket: "test-bucket" })[operation](key)).toBeNull();
  });

  it("preserves the access error when the exact key exists", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof ListObjectsV2Command) return { IsTruncated: false, KeyCount: 1, Contents: [{ Key: key }] };
      throw forbidden;
    });
    await expect(s3ObjectStore({ bucket: "test-bucket" })[operation](key)).rejects.toMatchObject({ status: 403, operation });
  });

  it("propagates a denied listing rather than inventing an absent object", async () => {
    const listingDenied = Object.assign(new Error("listing denied"), forbidden);
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof ListObjectsV2Command) throw listingDenied;
      throw forbidden;
    });
    await expect(s3ObjectStore({ bucket: "test-bucket" })[operation](key)).rejects.toBe(listingDenied);
  });

  it.each([
    {},
    { IsTruncated: true, KeyCount: 1, Contents: [{ Key: `${key}.backup` }] },
    { IsTruncated: false, KeyCount: 1, Contents: [{}] },
    { IsTruncated: false, KeyCount: 0, Contents: [{ Key: `${key}.backup` }] },
    { IsTruncated: false, KeyCount: 1, Contents: [{ Key: "other-prefix" }] },
  ])("fails closed for an inconclusive listing", async listing => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof ListObjectsV2Command) return listing;
      throw forbidden;
    });
    await expect(s3ObjectStore({ bucket: "test-bucket" })[operation](key)).rejects.toMatchObject({ status: 403, operation });
  });
});
