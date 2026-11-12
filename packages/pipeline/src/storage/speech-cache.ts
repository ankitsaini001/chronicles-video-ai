import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CharacterAlignmentSchema, SAFE_ID_PATTERN, Sha256Schema } from "../contracts";
import { sha256 } from "../shared/hash";
import { atomicWriteFile } from "./local-artifact-store";

/**
 * Owner-scoped, content-addressed speech cache (PIPELINE_DESIGN.md §8: "reuse a speech artifact only
 * if the narration input, pronunciation mapping, voice ID, model and relevant settings all match";
 * "never reuse across owners").
 *
 * Layout: <runs root>/<owner>/.speech-cache/<cache-key-hex>.mp3 + .json. The key is computed by the
 * speech stage from exactly those inputs, so a hit can only ever return audio for the same request.
 * A provider response is written here immediately after it arrives, before any later step can fail,
 * so a paid request is never lost (resume and later versions reuse it instead of calling again).
 */

export const SpeechCacheRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cacheKey: Sha256Schema,
  audioSha256: Sha256Schema,
  audioBytes: z.number().int().positive(),
  /** The request without secrets (the API key is never part of it). */
  request: z.record(z.string(), z.unknown()),
  alignment: CharacterAlignmentSchema.nullable(),
  normalizedAlignment: CharacterAlignmentSchema.nullable(),
  requestId: z.string().nullable(),
  characterCost: z.number().int().nonnegative().nullable(),
  charactersSent: z.number().int().nonnegative(),
  synthesizedAt: z.iso.datetime(),
});
export type SpeechCacheRecord = z.infer<typeof SpeechCacheRecordSchema>;

export interface SpeechCacheHit {
  record: SpeechCacheRecord;
  audio: Uint8Array;
}

export interface SpeechCache {
  get(ownerId: string, cacheKey: string): Promise<SpeechCacheHit | null>;
  put(ownerId: string, record: SpeechCacheRecord, audio: Uint8Array): Promise<void>;
}

export class LocalSpeechCache implements SpeechCache {
  readonly root: string;

  constructor(runsRoot: string) {
    this.root = path.resolve(runsRoot);
  }

  private paths(ownerId: string, cacheKey: string): { audio: string; record: string } {
    if (!SAFE_ID_PATTERN.test(ownerId)) throw new Error(`owner "${ownerId}" is not a safe ID`);
    const parsed = Sha256Schema.safeParse(cacheKey);
    if (!parsed.success) throw new Error(`speech cache key "${cacheKey}" is not a sha256 hash`);
    const dir = path.join(this.root, ownerId, ".speech-cache");
    const hex = cacheKey.slice("sha256:".length);
    return { audio: path.join(dir, `${hex}.mp3`), record: path.join(dir, `${hex}.json`) };
  }

  async get(ownerId: string, cacheKey: string): Promise<SpeechCacheHit | null> {
    const p = this.paths(ownerId, cacheKey);
    let recordText: string;
    let audio: Uint8Array;
    try {
      recordText = await fs.readFile(p.record, "utf8");
      audio = await fs.readFile(p.audio);
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(recordText);
    } catch {
      return null;
    }
    const record = SpeechCacheRecordSchema.safeParse(raw);
    // Never trust a cache entry that does not match its own key and audio hash.
    if (!record.success || record.data.cacheKey !== cacheKey || sha256(audio) !== record.data.audioSha256) return null;
    return { record: record.data, audio };
  }

  async put(ownerId: string, record: SpeechCacheRecord, audio: Uint8Array): Promise<void> {
    const p = this.paths(ownerId, record.cacheKey);
    const checked = SpeechCacheRecordSchema.parse(record);
    if (sha256(audio) !== checked.audioSha256) throw new Error("internal: speech cache audio hash mismatch");
    // Audio first, then the record: a record only exists when its audio is complete.
    await atomicWriteFile(p.audio, audio);
    await atomicWriteFile(p.record, Buffer.from(`${JSON.stringify(checked, null, 2)}\n`, "utf8"));
  }
}
