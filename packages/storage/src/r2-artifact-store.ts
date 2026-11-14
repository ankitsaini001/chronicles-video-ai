import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertArtifactKey,
  ArtifactKeys,
  InvalidArtifactKeyError,
  type ArtifactStore,
  type RunRef,
  type RunWriter,
  type WrittenArtifact,
} from "@bytereel/pipeline/storage";
import { r2Endpoint, type R2Config } from "./config";
import { attachmentContentDisposition } from "./content-disposition";
import { assertStorageKey, StorageKeys, type RenderRef, type StorageKey } from "./keys";

/** Presigned link lifetimes (ARCHITECTURE §9): 15 min for the browser, at most 2 h (Instagram fetch, D5). */
export const DEFAULT_PRESIGN_TTL_SECONDS = 900;
export const MAX_PRESIGN_TTL_SECONDS = 7200;

/** The only content types we store. Anything else is refused (we never serve HTML from the bucket). */
export const CONTENT_TYPES = {
  json: "application/json",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  png: "image/png",
  jpg: "image/jpeg",
  text: "text/plain; charset=utf-8",
} as const;
export type StorageContentType = (typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES];
const ALLOWED_CONTENT_TYPES = new Set<string>(Object.values(CONTENT_TYPES));

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

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** One S3 client for R2: region "auto", the account's endpoint, path-style addressing. */
export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(config.accountId),
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Only send/check checksums when an operation needs them (R2 compatibility); we add SHA-256 ourselves.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NoSuchKey" || name === "NotFound" || httpStatus(error) === 404;
}

/**
 * Pipeline run artifacts that live in R2, mapped to the render folder of ARCHITECTURE §9
 * (a run's versionId is the render's id). Plans, approvals and the manifest live in MongoDB;
 * narration audio/alignment go to users/{ownerId}/speech/… (F23).
 */
const RUN_ARTIFACTS: Record<string, { key: (ref: RenderRef) => StorageKey; contentType: StorageContentType }> = {
  [ArtifactKeys.timeline]: { key: StorageKeys.renderTimeline, contentType: CONTENT_TYPES.json },
  [ArtifactKeys.captions]: { key: StorageKeys.renderCaptions, contentType: CONTENT_TYPES.json },
  [ArtifactKeys.output]: { key: StorageKeys.renderOutput, contentType: CONTENT_TYPES.mp4 },
  [ArtifactKeys.qa]: { key: StorageKeys.renderQa, contentType: CONTENT_TYPES.json },
};

/**
 * Private Cloudflare R2 storage (ARCHITECTURE §6 rule 2, §9). Implements the pipeline's
 * `ArtifactStore` so stage code does not change, and adds put/get/head by key plus presigned links.
 *
 * Nothing here ever makes an object public: no ACLs, no public URLs; reading from a browser is only
 * possible through a short-lived presigned GET link.
 */
export class R2ArtifactStore implements ArtifactStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly allowHealthcheck: boolean;

  /**
   * @param options.allowHealthcheck only `npm run storage -- check` sets this, to use the healthcheck/ prefix.
   */
  constructor(options: { bucket: string; client: S3Client; allowHealthcheck?: boolean }) {
    this.bucket = options.bucket;
    this.client = options.client;
    this.allowHealthcheck = options.allowHealthcheck ?? false;
  }

  static fromConfig(config: R2Config, options: { allowHealthcheck?: boolean } = {}): R2ArtifactStore {
    return new R2ArtifactStore({ bucket: config.bucket, client: createR2Client(config), ...options });
  }

  private checkKey(key: StorageKey): void {
    assertStorageKey(key, { allowHealthcheck: this.allowHealthcheck });
  }

  /** Upload a file. Returns its SHA-256 (also saved on the object as metadata) and size. */
  async put(key: StorageKey, data: string | Uint8Array, contentType: StorageContentType): Promise<StoredObject> {
    this.checkKey(key);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("content type is not allowed");
    const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hex = sha256Hex(body);
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
      }),
    );
    return { key, sha256: `sha256:${hex}`, bytes: body.byteLength };
  }

  /** Download a file, or null if it doesn't exist. */
  async get(key: StorageKey): Promise<Uint8Array | null> {
    this.checkKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Size, type and saved SHA-256 of a file without downloading it, or null if it doesn't exist. */
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
      if (isNotFound(error)) return null;
      throw error;
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
    const url = await getSignedUrl(this.client, command, { expiresIn: ttl });
    return { url, expiresAt: new Date(signedAt + ttl * 1000) };
  }

  // ---------- ArtifactStore (pipeline runs) ----------

  /** run.versionId is the render id; all three ids must be MongoDB ObjectIds. */
  private runKey(run: RunRef, artifactKey: string): { key: StorageKey; contentType: StorageContentType } {
    assertArtifactKey(artifactKey);
    const entry = RUN_ARTIFACTS[artifactKey];
    if (!entry) {
      throw new InvalidArtifactKeyError(
        `"${artifactKey}" is not stored in R2 (only ${Object.keys(RUN_ARTIFACTS).join(", ")}; plans and approvals live in MongoDB)`,
      );
    }
    return { key: entry.key({ ownerId: run.ownerId, projectId: run.projectId, renderId: run.versionId }), contentType: entry.contentType };
  }

  /**
   * No lock object in R2: in the app the single writer per render is the MongoDB job
   * (one active job per project, DATABASE.md jobs). Writes go straight to the final key; an R2 PUT
   * is atomic (readers see the old file or the complete new one, never half a file).
   */
  async acquireWriter(run: RunRef): Promise<RunWriter> {
    this.runKey(run, ArtifactKeys.output); // validate the ids now, not on the first write
    return new R2RunWriter(run, this);
  }

  /** Used by R2RunWriter. */
  async writeRunArtifact(run: RunRef, artifactKey: string, data: string | Uint8Array): Promise<WrittenArtifact> {
    const { key, contentType } = this.runKey(run, artifactKey);
    const stored = await this.put(key, data, contentType);
    return { key: artifactKey, sha256: stored.sha256, bytes: stored.bytes };
  }

  async read(run: RunRef, key: string): Promise<Uint8Array | null> {
    return this.get(this.runKey(run, key).key);
  }

  async readJson(run: RunRef, key: string): Promise<unknown | null> {
    const data = await this.read(run, key);
    if (data === null) return null;
    try {
      return JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      throw new Error(`${key} in ${this.describeRun(run)} is not valid JSON`);
    }
  }

  async exists(run: RunRef, key: string): Promise<boolean> {
    return (await this.head(this.runKey(run, key).key)) !== null;
  }

  async verify(run: RunRef, key: string, expectedSha256: string): Promise<boolean> {
    const data = await this.read(run, key);
    return data !== null && `sha256:${sha256Hex(data)}` === expectedSha256;
  }

  describeRun(run: RunRef): string {
    const output = this.runKey(run, ArtifactKeys.output).key;
    return `r2://${this.bucket}/${output.slice(0, output.lastIndexOf("/"))}`;
  }
}

class R2RunWriter implements RunWriter {
  private released = false;

  constructor(
    readonly run: RunRef,
    private readonly store: R2ArtifactStore,
  ) {}

  async write(key: string, data: string | Uint8Array): Promise<WrittenArtifact> {
    if (this.released) throw new Error("this run writer was released; acquire a new one to write");
    return this.store.writeRunArtifact(this.run, key, data);
  }

  async writeJson(key: string, value: unknown): Promise<WrittenArtifact> {
    return this.write(key, `${JSON.stringify(value, null, 2)}\n`);
  }

  async release(): Promise<void> {
    this.released = true;
  }
}
