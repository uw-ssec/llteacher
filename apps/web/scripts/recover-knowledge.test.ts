import { afterEach, describe, expect, it, vi } from "vitest";
import { GetBucketVersioningCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { strToU8, zipSync } from "fflate";
import { main } from "./recover-knowledge";

const course = "11111111-2222-4333-8444-555555555555";
const args = ["--bucket", "test-bucket", "--course", course, "--version", "selected-prior-version"];
const body = (value: string) => ({ transformToByteArray: async () => new TextEncoder().encode(value) });
afterEach(() => vi.restoreAllMocks());

describe("operator recovery CLI", () => {
  it("can restore a selected version when missing current manifest GET returns 403", async () => {
    const puts: PutObjectCommand[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.VersionId) return { Body: body('{"version":1,"files":{}}') };
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof GetObjectCommand) throw { $metadata: { httpStatusCode: 403 } };
      if (command instanceof ListObjectsV2Command) return { IsTruncated: false, KeyCount: 0 };
      if (command instanceof PutObjectCommand) { puts.push(command); return {}; }
      throw new Error("unexpected request");
    });
    await main([...args, "--apply", "--writer-stopped"]);
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({ Key: `courses/${course}/knowledge/manifest.json`, IfNoneMatch: "*" });
  });

  it("checks missing legacy blobs with a narrow listing before conditional creation", async () => {
    const archive = zipSync({ "knowledge/lesson.md": strToU8("legacy content") });
    const puts: PutObjectCommand[] = [];
    const prefixes: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.VersionId) return { Body: { transformToByteArray: async () => archive } };
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof GetObjectCommand) throw { $metadata: { httpStatusCode: 403 } };
      if (command instanceof ListObjectsV2Command) { prefixes.push(command.input.Prefix!); return { IsTruncated: false, KeyCount: 0 }; }
      if (command instanceof PutObjectCommand) { puts.push(command); return {}; }
      throw new Error("unexpected request");
    });
    await main([...args, "--format", "legacy", "--apply", "--writer-stopped"]);
    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).toBe(`courses/${course}/knowledge/manifest.json`);
    expect(prefixes[1]).toMatch(new RegExp(`^courses/${course}/knowledge/blobs/[a-f0-9]{64}$`));
    expect(puts.map(command => command.input.Key)).toEqual([prefixes[1], prefixes[0]]);
    expect(puts.every(command => command.input.IfNoneMatch === "*")).toBe(true);
  });

  it("never uses a current-object listing to excuse a failed selected-version read", async () => {
    const denied = Object.assign(new Error("selected version denied"), { $metadata: { httpStatusCode: 403 } });
    const commands: unknown[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => { commands.push(command); throw denied; });
    await expect(main(args)).rejects.toBe(denied);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("requires the explicit writer-stopped acknowledgement before any apply request", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    await expect(main([...args, "--apply"])).rejects.toThrow("Stop all application writers");
    expect(send).not.toHaveBeenCalled();
  });

  it("reads exactly the selected version and makes no writes during dry run", async () => {
    const commands: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      commands.push(command);
      if (command instanceof GetObjectCommand && command.input.VersionId === "selected-prior-version") return { Body: body('{"version":1,"files":{}}') };
      throw new Error("unexpected request");
    });
    await main(args);
    expect(commands).toHaveLength(1);
  });

  it("backs up the current bytes and conditionally publishes against their ETag", async () => {
    const puts: PutObjectCommand[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof GetObjectCommand) return { Body: body(command.input.VersionId ? '{"version":1,"files":{}}' : 'preserve broken current'), ETag: '"current-etag"' };
      if (command instanceof PutObjectCommand) { puts.push(command); return {}; }
      throw new Error("unexpected request");
    });
    await main([...args, "--apply", "--writer-stopped"]);
    expect(puts).toHaveLength(2);
    expect(puts[0].input.Key).toMatch(/\/knowledge\/recovery\/.*\.json$/);
    expect(new TextDecoder().decode(puts[0].input.Body as Uint8Array)).toBe("preserve broken current");
    expect(puts[0].input.IfNoneMatch).toBe("*");
    expect(puts[1].input).toMatchObject({ Key: `courses/${course}/knowledge/manifest.json`, IfMatch: '"current-etag"' });
  });

  it("refuses apply if S3 versioning is not enabled", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async command => {
      if (command instanceof GetObjectCommand) return { Body: body('{"version":1,"files":{}}') };
      if (command instanceof GetBucketVersioningCommand) return { Status: "Suspended" };
      throw new Error("unexpected write");
    });
    await expect(main([...args, "--apply", "--writer-stopped"])).rejects.toThrow("versioning enabled");
  });
});
