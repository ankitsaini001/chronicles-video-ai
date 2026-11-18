import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentContentDisposition,
  checkTtlSeconds,
  createR2Client,
  R2_CONNECTION_TIMEOUT_MS,
  R2_MAX_ATTEMPTS,
  R2_REQUEST_TIMEOUT_MS,
  StorageError,
  InvalidPresignOptionsError,
  InvalidStorageKeyError,
  isStorageKey,
  R2ArtifactStore,
  readR2Config,
  redactR2,
  StorageKeys,
  type StorageKey,
} from "../packages/storage/src";
import { healthcheckKey } from "../packages/storage/src/healthcheck";

const OWNER = "67330c1a9f1e4b2a7c0d1e01";
const PROJECT = "67330d5e9f1e4b2a7c0d2a10";
const RENDER = "67330f109f1e4b2a7c0d6f01";
const REF = { ownerId: OWNER, projectId: PROJECT, renderId: RENDER };
const HEX = "a".repeat(64);
const CACHE_KEY = `sha256:${HEX}`;

// Fake values only (never real credentials). Distinctive, so we can check they are never echoed.
const FAKE = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "FAKEACCESSKEYID0000000000000000a",
  R2_SECRET_ACCESS_KEY: "fakesecretfakesecretfakesecretfakesecretfakesecretfakesecret0000",
  R2_BUCKET: "reel-app-dev",
};

describe("storage key builder (ARCHITECTURE §9)", () => {
  it("builds the documented keys from ObjectIds and the speech cacheKey", () => {
    expect(StorageKeys.renderOutput(REF)).toBe(`users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/output.mp4`);
    expect(StorageKeys.renderTimeline(REF)).toMatch(/\/timeline\.json$/);
    expect(StorageKeys.renderCaptions(REF)).toMatch(/\/captions\.json$/);
    expect(StorageKeys.renderThumbnail(REF)).toMatch(/\/thumbnail\.jpg$/);
    expect(StorageKeys.renderQa(REF)).toMatch(/\/qa\.json$/);
    expect(StorageKeys.renderFrame(REF, 0)).toMatch(/\/frames\/0\.png$/);
    expect(StorageKeys.renderFrame(REF, 42)).toMatch(/\/frames\/42\.png$/);
    expect(StorageKeys.speechAudio(OWNER, CACHE_KEY)).toBe(`users/${OWNER}/speech/${HEX}/audio.mp3`);
    expect(StorageKeys.speechAlignment(OWNER, CACHE_KEY)).toBe(`users/${OWNER}/speech/${HEX}/alignment.json`);
    expect(StorageKeys.speechNormalizedAlignment(OWNER, CACHE_KEY)).toBe(`users/${OWNER}/speech/${HEX}/alignment.normalized.json`);
  });

  it("rejects bad ids, path tricks and empty values", () => {
    const bad = [
      "",
      "..",
      "../67330c1a9f1e4b2a7c0d1e01",
      "67330c1a9f1e4b2a7c0d1e01/..",
      "67330c1a9f1e4b2a7c0d1e0/",
      "67330c1a9f1e4b2a7c0d1e/x",
      "67330C1A9F1E4B2A7C0D1E01", // uppercase is not how we store ids
      "67330c1a9f1e4b2a7c0d1e011", // 25 characters
      "67330c1a9f1e4b2a7c0d1e0", // 23 characters
      "zz330c1a9f1e4b2a7c0d1e01",
      " 67330c1a9f1e4b2a7c0d1e01",
      "owner-1",
    ];
    for (const id of bad) {
      expect(() => StorageKeys.renderOutput({ ...REF, ownerId: id })).toThrow(InvalidStorageKeyError);
      expect(() => StorageKeys.renderOutput({ ...REF, projectId: id })).toThrow(InvalidStorageKeyError);
      expect(() => StorageKeys.renderOutput({ ...REF, renderId: id })).toThrow(InvalidStorageKeyError);
      expect(() => StorageKeys.speechAudio(id, CACHE_KEY)).toThrow(InvalidStorageKeyError);
    }
    for (const cacheKey of ["", HEX, `sha256:${HEX}/..`, `sha256:../${HEX.slice(3)}`, `sha256:${"A".repeat(64)}`, "sha256:"]) {
      expect(() => StorageKeys.speechAudio(OWNER, cacheKey)).toThrow(InvalidStorageKeyError);
    }
    for (const n of [-1, 1.5, 10000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => StorageKeys.renderFrame(REF, n)).toThrow(InvalidStorageKeyError);
    }
    // Non-strings from JSON input are refused too.
    expect(() => StorageKeys.renderOutput({ ...REF, ownerId: 123 as unknown as string })).toThrow(InvalidStorageKeyError);
  });

  it("accepts only full §9 keys; healthcheck/ only when explicitly allowed", () => {
    expect(isStorageKey(`users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/output.mp4`)).toBe(true);
    for (const key of [
      `users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/../output.mp4`,
      `users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/plan.json`,
      `users/${OWNER}/projects/${PROJECT}/plans/${RENDER}/plan.json`, // storyboard copy dropped (F22)
      `/users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/output.mp4`,
      `users/${OWNER}/projects/${PROJECT}/renders/${RENDER}/frames/01.png`,
      "healthcheck/20261114T101530Z-hello.txt",
      "",
    ]) {
      expect(isStorageKey(key)).toBe(false);
    }
    expect(isStorageKey("healthcheck/20261114T101530Z-hello.txt", { allowHealthcheck: true })).toBe(true);
    expect(isStorageKey("healthcheck/../users/x", { allowHealthcheck: true })).toBe(false);
    expect(healthcheckKey(new Date("2026-11-14T10:15:30.123Z"))).toBe("healthcheck/20261114T101530Z-hello.txt");
  });
});

describe("Content-Disposition for downloads", () => {
  it("plain ASCII titles get a simple quoted filename", () => {
    expect(attachmentContentDisposition("How UPI payments work.mp4")).toBe('attachment; filename="How UPI payments work.mp4"');
  });

  it("Hindi titles get an ASCII fallback plus an RFC 5987 UTF-8 filename*", () => {
    const value = attachmentContentDisposition("यूपीआई कैसे काम करता है.mp4");
    expect(value).toBe(
      `attachment; filename="download.mp4"; filename*=UTF-8''${encodeURIComponent("यूपीआई कैसे काम करता है.mp4")}`,
    );
    // Header values must be plain ASCII.
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    const encoded = /filename\*=UTF-8''(.+)$/.exec(value)?.[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("यूपीआई कैसे काम करता है.mp4");
  });

  it("mixed Hinglish/accented titles keep the ASCII part in the fallback", () => {
    const value = attachmentContentDisposition("UPI क्या है? Café.mp4");
    expect(value.startsWith('attachment; filename="UPI ? Cafe.mp4"; ')).toBe(true);
    expect(value).toContain("filename*=UTF-8''UPI%20");
  });

  it("removes quotes, path separators, control characters and escapes RFC 5987 specials", () => {
    const value = attachmentContentDisposition('../a"b\\c\r\nd\u0000(it\'s)*.mp4');
    expect(value).not.toMatch(/[\r\n\u0000]/);
    expect(value).not.toContain("/");
    const fallback = /filename="([^"]*)"/.exec(value)?.[1] ?? "";
    expect(fallback).not.toMatch(/["\\]/);
    const extended = /filename\*=UTF-8''(.+)$/.exec(value)?.[1] ?? "";
    expect(extended).not.toMatch(/['()*"\\ ]/);
    expect(decodeURIComponent(extended)).toBe("..-a\"b-cd(it's)*.mp4".replace(/^\.+/, ""));
  });

  it("a lone surrogate (broken text) doesn't crash: it becomes U+FFFD", () => {
    const value = attachmentContentDisposition("broken \uD800 title \uDC00.mp4");
    const encoded = /filename\*=UTF-8''(.+)$/.exec(value)?.[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("broken \uFFFD title \uFFFD.mp4");
    expect(value.startsWith('attachment; filename="broken title.mp4"')).toBe(true);
  });

  it("an empty or dots-only name falls back to download", () => {
    expect(attachmentContentDisposition("")).toBe('attachment; filename="download"');
    expect(attachmentContentDisposition("...")).toBe('attachment; filename="download"');
  });

  it("very long names are shortened and keep their extension", () => {
    const value = attachmentContentDisposition(`${"क".repeat(300)}.mp4`);
    const encoded = /filename\*=UTF-8''(.+)$/.exec(value)?.[1] ?? "";
    const name = decodeURIComponent(encoded);
    expect([...name].length).toBe(120);
    expect(name.endsWith(".mp4")).toBe(true);
  });
});

describe("R2 config reader", () => {
  it("reads all four variables", () => {
    const result = readR2Config({ ...FAKE });
    expect(result).toEqual({
      ok: true,
      config: { accountId: FAKE.R2_ACCOUNT_ID, accessKeyId: FAKE.R2_ACCESS_KEY_ID, secretAccessKey: FAKE.R2_SECRET_ACCESS_KEY, bucket: "reel-app-dev" },
    });
  });

  it("names every missing variable", () => {
    const result = readR2Config({});
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.problems.join("\n");
    for (const name of Object.keys(FAKE)) expect(text).toContain(`${name} is missing`);
    const one = readR2Config({ ...FAKE, R2_SECRET_ACCESS_KEY: "  " });
    expect(one.ok ? [] : one.problems).toEqual([expect.stringContaining("R2_SECRET_ACCESS_KEY is missing")]);
  });

  it("explains wrong values without ever printing them", () => {
    const wrong = {
      R2_ACCOUNT_ID: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      R2_ACCESS_KEY_ID: "has space secretvalue1",
      R2_SECRET_ACCESS_KEY: '"quotedsecretvalue12345"',
      R2_BUCKET: "Reel_App",
    };
    const result = readR2Config(wrong);
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.problems.join("\n");
    expect(result.ok ? 0 : result.problems.length).toBe(4);
    for (const value of Object.values(wrong)) expect(text).not.toContain(value);
    expect(text).not.toContain("0123456789abcdef0123456789abcdef");
    expect(text).not.toContain("secretvalue");
    // Success results hold values, but problems never do even when the others are valid.
    const partial = readR2Config({ ...FAKE, R2_BUCKET: "" });
    const partialText = partial.ok ? "" : partial.problems.join("\n");
    for (const value of [FAKE.R2_ACCOUNT_ID, FAKE.R2_ACCESS_KEY_ID, FAKE.R2_SECRET_ACCESS_KEY]) expect(partialText).not.toContain(value);
  });

  it("redactR2 hides the account id and both key parts", () => {
    const config = { accountId: FAKE.R2_ACCOUNT_ID, accessKeyId: FAKE.R2_ACCESS_KEY_ID, secretAccessKey: FAKE.R2_SECRET_ACCESS_KEY };
    const text = redactR2(`getaddrinfo ENOTFOUND ${FAKE.R2_ACCOUNT_ID}.r2.cloudflarestorage.com ${FAKE.R2_ACCESS_KEY_ID} ${FAKE.R2_SECRET_ACCESS_KEY}`, config);
    for (const value of Object.values(config)) expect(text).not.toContain(value);
  });
});

describe("presigned link TTL bounds", () => {
  it("defaults to 900 s and allows 1..7200", () => {
    expect(checkTtlSeconds(undefined)).toBe(900);
    expect(checkTtlSeconds(1)).toBe(1);
    expect(checkTtlSeconds(60)).toBe(60);
    expect(checkTtlSeconds(7200)).toBe(7200);
  });

  it("refuses 0, negative, fractional and anything over 2 hours", () => {
    for (const ttl of [0, -1, 1.5, 7201, 604800, Number.NaN]) expect(() => checkTtlSeconds(ttl)).toThrow(InvalidPresignOptionsError);
  });
});

// ---------- R2ArtifactStore with a mocked S3 client ----------

const CONFIG = { accountId: FAKE.R2_ACCOUNT_ID, accessKeyId: FAKE.R2_ACCESS_KEY_ID, secretAccessKey: FAKE.R2_SECRET_ACCESS_KEY, bucket: "reel-app-dev" };

function sdkError(name: string, status: number | null, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}), ...extra });
}

function mockedStore(options: { allowHealthcheck?: boolean } = {}) {
  // A real client with fake credentials: signing works offline; `send` is replaced, so nothing goes over the network.
  const client = createR2Client(CONFIG);
  const objects = new Map<string, { body: Uint8Array; contentType: string; metadata: Record<string, string> }>();
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof PutObjectCommand) {
      const input = command.input;
      if (input.IfNoneMatch === "*" && objects.has(input.Key!)) throw sdkError("PreconditionFailed", 412);
      objects.set(input.Key!, { body: input.Body as Uint8Array, contentType: input.ContentType!, metadata: input.Metadata ?? {} });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const found = objects.get(command.input.Key!);
      if (!found) throw sdkError("NoSuchKey", 404);
      return { Body: { transformToByteArray: async () => found.body } };
    }
    if (command instanceof HeadObjectCommand) {
      const found = objects.get(command.input.Key!);
      if (!found) throw sdkError("NotFound", 404);
      return { ContentLength: found.body.byteLength, ContentType: found.contentType, Metadata: found.metadata };
    }
    throw new Error("unexpected command");
  });
  (client as unknown as { send: typeof send }).send = send;
  const store = new R2ArtifactStore({ bucket: "reel-app-dev", client, secrets: CONFIG, ...options });
  return { store, send, objects };
}

describe("R2ArtifactStore (mocked S3 client)", () => {
  it("the client has timeouts and a fixed number of attempts", async () => {
    const client = createR2Client(CONFIG);
    expect(await client.config.maxAttempts()).toBe(R2_MAX_ATTEMPTS);
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<{ connectionTimeout?: number; requestTimeout?: number }> };
    expect(await handler.configProvider).toMatchObject({ connectionTimeout: R2_CONNECTION_TIMEOUT_MS, requestTimeout: R2_REQUEST_TIMEOUT_MS });
    expect(R2_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(R2_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it("put sends bucket, key, the content type from the key and SHA-256 and returns the hash and size", async () => {
    const { store, send } = mockedStore();
    const key = StorageKeys.renderQa(REF);
    const stored = await store.put(key, '{"ok":true}');
    const hex = createHash("sha256").update('{"ok":true}').digest("hex");
    expect(stored).toEqual({ key, sha256: `sha256:${hex}`, bytes: 11 });
    const input = (send.mock.calls[0]![0] as PutObjectCommand).input;
    expect(input).toMatchObject({
      Bucket: "reel-app-dev",
      Key: key,
      ContentType: "application/json",
      ContentLength: 11,
      Metadata: { sha256: hex },
      ChecksumSHA256: Buffer.from(hex, "hex").toString("base64"),
    });
    expect(input).not.toHaveProperty("ACL"); // never public
    expect(input).not.toHaveProperty("IfNoneMatch"); // overwrite allowed unless createOnly
  });

  it("content types follow the key extension", async () => {
    const { store, send } = mockedStore({ allowHealthcheck: true });
    const cases: [StorageKey, string][] = [
      [StorageKeys.renderOutput(REF), "video/mp4"],
      [StorageKeys.speechAudio(OWNER, CACHE_KEY), "audio/mpeg"],
      [StorageKeys.renderFrame(REF, 1), "image/png"],
      [StorageKeys.renderThumbnail(REF), "image/jpeg"],
      [StorageKeys.speechAlignment(OWNER, CACHE_KEY), "application/json"],
      [healthcheckKey(), "text/plain; charset=utf-8"],
    ];
    for (const [key, type] of cases) {
      await store.put(key, "x");
      expect((send.mock.lastCall![0] as PutObjectCommand).input.ContentType).toBe(type);
    }
  });

  it("createOnly sends If-None-Match: * and a second upload is refused with already_exists", async () => {
    const { store, send } = mockedStore();
    const key = StorageKeys.renderOutput(REF);
    await store.put(key, "first", { createOnly: true });
    expect((send.mock.lastCall![0] as PutObjectCommand).input.IfNoneMatch).toBe("*");
    const error = await store.put(key, "second", { createOnly: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ operation: "put", code: "already_exists", status: 412 });
    expect(Buffer.from((await store.get(key))!).toString()).toBe("first");
  });

  it("get and head return the file, its size and saved hash; null when missing", async () => {
    const { store } = mockedStore();
    const key = StorageKeys.renderOutput(REF);
    expect(await store.get(key)).toBeNull();
    expect(await store.head(key)).toBeNull();
    const stored = await store.put(key, new Uint8Array([1, 2, 3, 4]));
    expect(Array.from((await store.get(key))!)).toEqual([1, 2, 3, 4]);
    expect(await store.head(key)).toEqual({ bytes: 4, contentType: "video/mp4", sha256: stored.sha256 });
  });

  it("get treats only NoSuchKey as missing: a missing bucket or a bare 404 is an error", async () => {
    const { store, send } = mockedStore();
    const key = StorageKeys.renderOutput(REF);
    send.mockRejectedValueOnce(sdkError("NoSuchBucket", 404));
    await expect(store.get(key)).rejects.toMatchObject({ name: "StorageError", operation: "get", code: "bucket_not_found", status: 404 });
    send.mockRejectedValueOnce(sdkError("UnknownError", 404));
    await expect(store.get(key)).rejects.toMatchObject({ code: "failed", status: 404 });
    send.mockRejectedValueOnce(sdkError("AccessDenied", 403));
    await expect(store.get(key)).rejects.toMatchObject({ code: "access_denied", status: 403 });
  });

  it("checkBucket passes, or fails loudly on a missing bucket or refused token", async () => {
    const { store, send } = mockedStore();
    await expect(store.checkBucket()).resolves.toBeUndefined();
    expect((send.mock.lastCall![0] as HeadBucketCommand).input).toEqual({ Bucket: "reel-app-dev" });
    send.mockRejectedValueOnce(sdkError("NotFound", 404));
    await expect(store.checkBucket()).rejects.toMatchObject({ operation: "checkBucket", code: "bucket_not_found" });
    send.mockRejectedValueOnce(sdkError("Forbidden", 403));
    await expect(store.checkBucket()).rejects.toMatchObject({ operation: "checkBucket", code: "access_denied" });
  });

  it("wraps network errors in a StorageError whose message and cause never show the account host or keys", async () => {
    const { store, send } = mockedStore();
    const host = `${FAKE.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    send.mockRejectedValueOnce(
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (key ${FAKE.R2_ACCESS_KEY_ID}, ${FAKE.R2_SECRET_ACCESS_KEY})`), {
        code: "ENOTFOUND",
        hostname: host,
      }),
    );
    const error = await store.put(StorageKeys.renderQa(REF), "{}").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    const storageError = error as StorageError;
    expect(storageError).toMatchObject({ operation: "put", code: "network", status: null });
    expect(storageError.message).toBe("Storage put failed: couldn't reach R2 (check the internet connection)");
    const cause = storageError.cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).toContain("ENOTFOUND [hidden].r2.cloudflarestorage.com");
    expect(cause).not.toHaveProperty("hostname"); // a new error, not the original object
    const everything = [storageError.message, storageError.stack, cause.message, cause.stack, JSON.stringify(storageError), String(storageError.cause)].join("\n");
    for (const secret of [FAKE.R2_ACCOUNT_ID, FAKE.R2_ACCESS_KEY_ID, FAKE.R2_SECRET_ACCESS_KEY]) expect(everything).not.toContain(secret);
  });

  it("classifies timeouts", async () => {
    const { store, send } = mockedStore();
    send.mockRejectedValueOnce(sdkError("TimeoutError", null));
    await expect(store.head(StorageKeys.renderQa(REF))).rejects.toMatchObject({ operation: "head", code: "timeout" });
  });

  it("refuses keys not built by the key builder and healthcheck/ without permission", async () => {
    const { store, send } = mockedStore();
    await expect(store.put("users/../x.mp4" as StorageKey, "x")).rejects.toThrow(InvalidStorageKeyError);
    await expect(store.put(healthcheckKey(), "x")).rejects.toThrow(InvalidStorageKeyError);
    await expect(store.get("healthcheck/../../etc" as StorageKey)).rejects.toThrow(InvalidStorageKeyError);
    expect(send).not.toHaveBeenCalled();
    const allowed = mockedStore({ allowHealthcheck: true });
    await expect(allowed.store.put(healthcheckKey(), "hello")).resolves.toMatchObject({ bytes: 5 });
  });

  it("presignedGet signs a GET with the TTL and, for downloads, an encoded Content-Disposition", async () => {
    const { store, send } = mockedStore();
    const key = StorageKeys.renderOutput(REF);
    const before = Date.now();
    const plain = await store.presignedGet(key);
    const url = new URL(plain.url);
    expect(url.pathname).toBe(`/reel-app-dev/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.has("response-content-disposition")).toBe(false);
    expect(plain.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);

    const download = new URL((await store.presignedGet(key, { ttlSeconds: 7200, downloadFilename: "यूपीआई.mp4" })).url);
    expect(download.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect(download.searchParams.get("response-content-disposition")).toBe(attachmentContentDisposition("यूपीआई.mp4"));

    await expect(store.presignedGet(key, { ttlSeconds: 7201 })).rejects.toThrow(InvalidPresignOptionsError);
    await expect(store.presignedGet("users/x" as StorageKey)).rejects.toThrow(InvalidStorageKeyError);
    expect(send).not.toHaveBeenCalled(); // signing is local
  });
});

describe("healthcheck/ is only for the storage check command", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "runs", "out"]);
  // The definition (packages/storage/src) and tests are allowed; the only USER is tools/cli/storage.ts.
  const ALLOWED = [/^packages\/storage\/src\//, /^tools\/cli\/storage\.ts$/];

  async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("no code outside tools/cli/storage.ts uses allowHealthcheck or the healthcheck key", async () => {
    const offenders: string[] = [];
    for (const top of ["apps", "packages", "tools"]) {
      for (const file of await sourceFiles(path.join(ROOT, top))) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (ALLOWED.some((pattern) => pattern.test(rel))) continue;
        const text = await readFile(file, "utf8");
        if (/allowHealthcheck|@bytereel\/storage\/healthcheck|healthcheckKey|healthcheckStorageKey/.test(text)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("npm run storage -- check (offline parts)", () => {
  it("shows usage for anything but check, and names missing variables without contacting R2", async () => {
    const { runStorageCommand } = await import("../tools/cli/storage");
    const lines: string[] = [];
    expect(await runStorageCommand([], (l) => lines.push(l), {})).toBe(2);
    expect(await runStorageCommand(["check", "--force"], (l) => lines.push(l), {})).toBe(2);
    lines.length = 0;
    expect(await runStorageCommand(["check"], (l) => lines.push(l), { R2_ACCOUNT_ID: FAKE.R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY: "bad value with spaces" })).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("FAIL  config");
    expect(text).toContain("R2_ACCESS_KEY_ID is missing");
    expect(text).toContain("R2_BUCKET is missing");
    expect(text).toContain("R2_SECRET_ACCESS_KEY doesn't look right");
    expect(text).not.toContain(FAKE.R2_ACCOUNT_ID);
    expect(text).not.toContain("bad value");
  });
});
