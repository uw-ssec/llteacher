/* --------------------------------------------------------------------------
   Object storage for uploaded materials (#42).

   Backed by Neon Object Storage, which speaks the real S3 wire protocol. Two
   reasons it beats a Cloudflare binding here, beyond avoiding a second
   vendor account:

     · Its buckets are BRANCH-AWARE. Branching a Neon database forks its
       buckets with it, copy-on-write -- so a preview branch gets its own
       materials instantly, without copying a byte. Nothing in R2 does that,
       and this project already branches its database for development.

     · It is S3, so the AWS + Pulumi move (#81) changes an endpoint and a
       pair of credentials, not this file's shape.

   The four-method interface is what keeps that migration cheap: nothing
   outside this file imports an S3 type, so a future implementation swap
   touches one module and no callers.
   -------------------------------------------------------------------------- */

import { AwsClient } from "aws4fetch";

export interface StoredObject {
  key: string;
  size: number;
  contentType: string | null;
}

export interface ObjectStore {
  put(key: string, body: ArrayBuffer, opts: { contentType?: string }): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
}

/** Carries the HTTP status structurally rather than in a message string, so a
 *  caller can branch on it. Neon returns 503 SlowDown when throttling, which
 *  is worth retrying; a 403 never is. Without this, both read as "failed". */
export class StorageError extends Error {
  constructor(
    readonly operation: "put" | "get" | "delete" | "head",
    readonly status: number,
  ) {
    super(`storage ${operation} failed: ${status}`);
    this.name = "StorageError";
  }
  /** 503 is Neon's documented throttle; 5xx generally is worth another attempt.
   *  4xx is the caller's problem and will fail identically next time. */
  get retryable(): boolean {
    return this.status >= 500;
  }
}

/** Course-prefixed on purpose: deleting a course becomes a prefix sweep, and
 *  a key that crosses courses is visibly wrong in a log line rather than
 *  needing a database lookup to notice. */
export function materialStorageKey(
  courseId: string,
  materialId: string,
  filename: string,
): string {
  // Only the basename, and only characters that survive a URL and a bucket
  // listing. A caller cannot traverse out of its own prefix.
  const base = filename.split("/").pop()?.split("\\").pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return `courses/${courseId}/materials/${materialId}/${safe || "upload"}`;
}

export interface S3StoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export function s3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region ?? "us-east-2",
  });
  const url = (key: string) =>
    `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

  return {
    async put(key, body, opts) {
      const res = await client.fetch(url(key), {
        method: "PUT",
        body,
        headers: opts.contentType ? { "content-type": opts.contentType } : {},
      });
      if (!res.ok) throw new StorageError("put", res.status);
    },
    async get(key) {
      const res = await client.fetch(url(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError("get", res.status);
      return await res.arrayBuffer();
    },
    async delete(key) {
      const res = await client.fetch(url(key), { method: "DELETE" });
      // S3 returns 204 for a delete of a key that was never there. Treat 404
      // the same way so callers can delete idempotently.
      if (!res.ok && res.status !== 404) {
        throw new StorageError("delete", res.status);
      }
    },
    async head(key) {
      const res = await client.fetch(url(key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError("head", res.status);
      const size = Number(res.headers.get("content-length") ?? "0");
      return { key, size, contentType: res.headers.get("content-type") };
    },
  };
}

/** One place that turns Env into a store, so no route reaches for the
 *  credential names itself. */
export function storageFromEnv(env: Env): ObjectStore {
  return s3ObjectStore({
    endpoint: env.STORAGE_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  });
}

export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, { body: ArrayBuffer; contentType: string | null }>();
  return {
    async put(key, body, opts) {
      objects.set(key, { body, contentType: opts.contentType ?? null });
    },
    async get(key) {
      return objects.get(key)?.body ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async head(key) {
      const object = objects.get(key);
      return object
        ? { key, size: object.body.byteLength, contentType: object.contentType }
        : null;
    },
  };
}
