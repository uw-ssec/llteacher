import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3ObjectStore, storageFromEnv } from "./objectStore";

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("AWS storage credentials", () => {
  it("accepts an AWS bucket without static credentials or an endpoint", () => {
    expect(() => storageFromEnv({ STORAGE_BUCKET: "materials", AWS_REGION: "us-west-2" } as unknown as Env)).not.toThrow();
  });

  it("resolves and signs requests with temporary ECS task-role credentials", async () => {
    const requests: Array<{ url: string | undefined; authorization: string; token: string | string[] | undefined }> = [];
    server = createServer((req, res) => {
      if (req.url?.startsWith("/credentials")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ AccessKeyId: "task-access", SecretAccessKey: "task-secret", Token: "task-token", Expiration: new Date(Date.now() + 3600000).toISOString() }));
      } else {
        requests.push({ url: req.url, authorization: String(req.headers.authorization), token: req.headers["x-amz-security-token"] });
        res.end("hello");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    const endpoint = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    vi.stubEnv("AWS_PROFILE", undefined);
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/llteacher-test-credentials");
    vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent/llteacher-test-config");
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", `${endpoint}/credentials`);
    const store = s3ObjectStore({ endpoint, bucket: "materials", region: "us-west-2" });
    expect(new TextDecoder().decode((await store.get("object"))!)).toBe("hello");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: "task-token" });
    expect(requests[0].authorization).toContain("Credential=task-access/");
    expect(requests[0].authorization).toContain("/us-west-2/s3/aws4_request");
  });
});
