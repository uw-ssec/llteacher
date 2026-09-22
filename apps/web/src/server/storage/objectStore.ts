import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

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
  endpoint?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

export function s3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    region: config.region ?? "us-west-2",
    // Omitting credentials activates the SDK chain, including refreshing ECS
    // task-role credentials. Explicit credentials are for local emulators.
    ...(config.endpoint && config.accessKeyId && config.secretAccessKey ? {
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    } : {}),
  });
  async function run<T>(operation: "put" | "get" | "delete" | "head", fn: () => Promise<T>): Promise<T | null> {
    try { return await fn(); } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 && operation !== "put") return null;
      if (status) throw new StorageError(operation, status);
      throw error;
    }
  }

  return {
    async put(key, body, opts) {
      await run("put", () => client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: new Uint8Array(body), ContentType: opts.contentType })));
    },
    async get(key) {
      const result = await run("get", () => client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })));
      if (!result?.Body) return null;
      return new Uint8Array(await result.Body.transformToByteArray()).buffer;
    },
    async delete(key) {
      await run("delete", () => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })));
    },
    async head(key) {
      const result = await run("head", () => client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })));
      return result ? { key, size: result.ContentLength ?? 0, contentType: result.ContentType ?? null } : null;
    },
  };
}

/** One place that turns Env into a store, so no route reaches for the
 *  credential names itself. */
/** Thrown when a deployment has not provisioned object storage (#81): the
 *  upload routes fail with this rather than a confusing S3 error. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Object storage is not configured: set STORAGE_BUCKET; local endpoints also require STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY.");
    this.name = "StorageNotConfiguredError";
  }
}

export function storageFromEnv(env: Env): ObjectStore {
  const { STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = env;
  if (!STORAGE_BUCKET || (STORAGE_ENDPOINT && (!STORAGE_ACCESS_KEY_ID || !STORAGE_SECRET_ACCESS_KEY))) {
    throw new StorageNotConfiguredError();
  }
  return s3ObjectStore({
    endpoint: STORAGE_ENDPOINT,
    bucket: STORAGE_BUCKET,
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
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
