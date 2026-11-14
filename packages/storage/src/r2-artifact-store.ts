import { createHash } from "node:crypto";
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Endpoint, redactR2, type R2Config } from "./config";
import { attachmentContentDisposition } from "./content-disposition";
import { assertStorageKey, type StorageKey } from "./keys";

/** Presigned link lifetimes (ARCHITECTURE §9): 15 min for the browser, at most 2 h (Instagram fetch, D5). */
export const DEFAULT_PRESIGN_TTL_SECONDS = 900;
export const MAX_PRESIGN_TTL_SECONDS = 7200;

/** Network limits for every R2 request (a stuck connection must not hang a job step). */
export const R2_CONNECTION_TIMEOUT_MS = 5_000;
export const R2_REQUEST_TIMEOUT_MS = 120_000;
export const R2_MAX_ATTEMPTS = 3;

/**
 * The content type of every file comes from its key's extension (keys are built by StorageKeys).
 * Only these types exist: we never store or serve HTML from the bucket.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  png: "image/png",
  jpg: "image/jpeg",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeForKey(key: StorageKey): string {
  const ext = /\.([a-z0-9]+)$/.exec(key)?.[1] ?? "";
  const type = CONTENT_TYPE_BY_EXTENSION[ext];
  if (!type) throw new Error("no content type for this key's extension");
  return type;
}

export interface StoredObject {
  key: StorageKey;
  /** "sha256:<hex>", computed here before upload; save it in MongoDB (ARCHITECTURE §9 integrity). */
  sha256: string;
  bytes: number;
}

export interface ObjectInfo {
  bytes: number;
  contentType: string | null;
  /** The sha256 saved with the object at upload ("sha256:<hex>"), or null if it has none. */
  sha256: string | null;
}

export interface PutOptions {
  /** Refuse (StorageError "already_exists") if a file with this key is already there. Use for finished artifacts. */
  createOnly?: boolean;
}

export interface PresignOptions {
  /** Default 900 s (15 min). Must be a whole number from 1 to 7200. */
  ttlSeconds?: number;
  /** Makes the browser download the file under this name (Content-Disposition: attachment). */
  downloadFilename?: string;
}

export interface PresignedLink {
  url: string;
  expiresAt: Date;
}

export class InvalidPresignOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPresignOptionsError";
  }
}

export function checkTtlSeconds(ttlSeconds: number | undefined): number {
  const ttl = ttlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_PRESIGN_TTL_SECONDS) {
    throw new InvalidPresignOptionsError(`ttlSeconds must be a whole number from 1 to ${MAX_PRESIGN_TTL_SECONDS}`);
  }
  return ttl;
}

// ---------- errors ----------

export type StorageOperation = "checkBucket" | "put" | "get" | "head" | "presign";
export type StorageErrorCode = "already_exists" | "access_denied" | "bucket_not_found" | "timeout" | "network" | "failed";

const PLAIN: Record<StorageErrorCode, string> = {
  already_exists: "a file with this key already exists",
  access_denied: "R2 refused the request (check the token has Object Read & Write on this bucket)",
  bucket_not_found: "the bucket was not found (check R2_BUCKET)",
  timeout: "R2 took too long to answer",
  network: "couldn't reach R2 (check the internet connection)",
  failed: "R2 returned an error",
};

/**
 * Every failure of the store. The message is plain and safe to show or log; `cause` is a NEW error
 * holding only the redacted name and message of the original (never the original object, whose
 * fields may contain the account host).
 */
export class StorageError extends Error {
  readonly operation: StorageOperation;
  readonly code: StorageErrorCode;
  readonly status: number | null;

  constructor(operation: StorageOperation, code: StorageErrorCode, status: number | null, cause?: Error) {
    super(`Storage ${operation} failed: ${PLAIN[code]}${status ? ` (HTTP ${status})` : ""}`, cause ? { cause } : undefined);
    this.name = "StorageError";
    this.operation = operation;
    this.code = code;
    this.status = status;
  }
}

interface SdkErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: number };
}

function errorName(error: unknown): string {
  const name = (error as SdkErrorShape | null)?.name;
  return typeof name === "string" ? name : "";
}

function httpStatus(error: unknown): number | null {
  return (error as SdkErrorShape | null)?.$metadata?.httpStatusCode ?? null;
}

function classify(operation: StorageOperation, error: unknown): StorageErrorCode {
  const name = errorName(error);
  const code = (error as SdkErrorShape | null)?.code;
  const status = httpStatus(error);
  if (name === "NoSuchBucket" || (operation === "checkBucket" && (status === 404 || name === "NotFound"))) return "bucket_not_found";
  if (name === "PreconditionFailed" || status === 412) return "already_exists";
  if (name === "AccessDenied" || status === 401 || status === 403) return "access_denied";
  if (name === "TimeoutError" || name === "RequestTimeout" || code === "ETIMEDOUT" || code === "ECONNABORTED") return "timeout";
  if (typeof code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) return "network";
  return "failed";
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** One S3 client for R2: region "auto", the account's endpoint, path-style, timeouts and retries set. */
export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(config.accountId),
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: R2_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: R2_CONNECTION_TIMEOUT_MS, requestTimeout: R2_REQUEST_TIMEOUT_MS },
    // Only send/check checksums when an operation needs them (R2 compatibility); we add SHA-256 ourselves.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

type Secrets = Pick<R2Config, "accountId" | "accessKeyId" | "secretAccessKey">;

/**
 * Private Cloudflare R2 storage (ARCHITECTURE §9): put/get/head by a key from `StorageKeys`, plus
 * presigned links. F23 calls it directly; the pipeline's LocalArtifactStore stays for the CLI and tests.
 *
 * Nothing here ever makes an object public: no ACLs, no public URLs; reading from a browser is only
 * possible through a short-lived presigned GET link.
 */
export class R2ArtifactStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly allowHealthcheck: boolean;
  private readonly secrets: Secrets | null;

  /**
   * @param options.secrets values hidden from error causes (set by fromConfig).
   * @param options.allowHealthcheck only `npm run storage -- check` sets this, to use the healthcheck/ prefix.
   */
  constructor(options: { bucket: string; client: S3Client; secrets?: Secrets; allowHealthcheck?: boolean }) {
    this.bucket = options.bucket;
    this.client = options.client;
    this.secrets = options.secrets ?? null;
    this.allowHealthcheck = options.allowHealthcheck ?? false;
  }

  static fromConfig(config: R2Config, options: { allowHealthcheck?: boolean } = {}): R2ArtifactStore {
    return new R2ArtifactStore({ bucket: config.bucket, client: createR2Client(config), secrets: config, ...options });
  }

  private checkKey(key: StorageKey): void {
    assertStorageKey(key, { allowHealthcheck: this.allowHealthcheck });
  }

  private wrap(operation: StorageOperation, error: unknown): StorageError {
    if (error instanceof StorageError) return error;
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const cause = new Error(this.secrets ? redactR2(raw, this.secrets) : raw);
    return new StorageError(operation, classify(operation, error), httpStatus(error), cause);
  }

  /** Fails loudly (StorageError) when the bucket is missing or the token can't use it. Call at worker/CLI start. */
  async checkBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      throw this.wrap("checkBucket", error);
    }
  }

  /**
   * Upload a file; the content type comes from the key's extension. Returns its SHA-256 (also checked
   * by R2 on upload and saved on the object as metadata) and size.
   */
  async put(key: StorageKey, data: string | Uint8Array, options: PutOptions = {}): Promise<StoredObject> {
    this.checkKey(key);
    const contentType = contentTypeForKey(key);
    const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hex = sha256Hex(body);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
          // R2 checks this and refuses the upload if the bytes it received are different.
          ChecksumSHA256: Buffer.from(hex, "hex").toString("base64"),
          Metadata: { sha256: hex },
          ...(options.createOnly ? { IfNoneMatch: "*" } : {}),
        }),
      );
    } catch (error) {
      throw this.wrap("put", error);
    }
    return { key, sha256: `sha256:${hex}`, bytes: body.byteLength };
  }

  /** Download a file, or null if it doesn't exist (only R2's NoSuchKey means "missing"). */
  async get(key: StorageKey): Promise<Uint8Array | null> {
    this.checkKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) throw new Error("R2 answered without a body");
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (errorName(error) === "NoSuchKey") return null;
      throw this.wrap("get", error);
    }
  }

  /**
   * Size, type and saved SHA-256 of a file without downloading it, or null if it doesn't exist.
   * A HEAD answer has no body, so a 404 can't tell "no file" from "no bucket": call checkBucket() first.
   */
  async head(key: StorageKey): Promise<ObjectInfo | null> {
    this.checkKey(key);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const saved = result.Metadata?.sha256;
      return {
        bytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        sha256: saved && /^[0-9a-f]{64}$/.test(saved) ? `sha256:${saved}` : null,
      };
    } catch (error) {
      if (errorName(error) === "NotFound" || httpStatus(error) === 404) return null;
      throw this.wrap("head", error);
    }
  }

  /**
   * A private, time-limited GET link (default 15 min, at most 2 h). Call it only after the
   * ownership check. With `downloadFilename` the browser downloads instead of playing.
   */
  async presignedGet(key: StorageKey, options: PresignOptions = {}): Promise<PresignedLink> {
    this.checkKey(key);
    const ttl = checkTtlSeconds(options.ttlSeconds);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.downloadFilename !== undefined
        ? { ResponseContentDisposition: attachmentContentDisposition(options.downloadFilename) }
        : {}),
    });
    const signedAt = Date.now();
    try {
      const url = await getSignedUrl(this.client, command, { expiresIn: ttl });
      return { url, expiresAt: new Date(signedAt + ttl * 1000) };
    } catch (error) {
      throw this.wrap("presign", error);
    }
  }
}
