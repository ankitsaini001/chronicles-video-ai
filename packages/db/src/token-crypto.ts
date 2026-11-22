import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Instagram tokens are stored ENCRYPTED (DATABASE.md §6.2, ARCHITECTURE §21.4): AES-256-GCM with a
// NEW random 12-byte IV for every encryption (re-using an IV with the same key would break GCM),
// stored as { ciphertext, iv, tag, keyVersion } in base64. The keys never touch the database: they
// come from the environment,
//   TOKEN_ENCRYPTION_KEYS            a JSON map { "<version>": "<base64 of 32 random bytes>" }
//   TOKEN_ENCRYPTION_ACTIVE_VERSION  the version used for NEW encryptions (e.g. "1")
// Old versions stay in the map so tokens saved with them can still be read (key rotation: decrypt
// with the old key, encrypt again with the active one). Problems name the setting, never a value.
// Each token is BOUND to its record (F28 review): the "additional authenticated data" is
// `${ownerId}:${igUserId}` (tokenAad), so a ciphertext copied into another user's document, or
// onto another Instagram account, can't be decrypted there.

export type EncryptedToken = { ciphertext: string; iv: string; tag: string; keyVersion: string };

export type TokenKeys = { activeVersion: string; keys: ReadonlyMap<string, Buffer> };

export type TokenKeysResult = { ok: true; keys: TokenKeys } | { ok: false; problems: string[] };

export const TOKEN_KEYS_ENV = "TOKEN_ENCRYPTION_KEYS";
export const TOKEN_ACTIVE_VERSION_ENV = "TOKEN_ENCRYPTION_ACTIVE_VERSION";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = /^[A-Za-z0-9_-]{1,16}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const MAKE_KEY = "Make a key with: openssl rand -base64 32";

/** The record a token belongs to: `${ownerId}:${igUserId}` (owner as the 24-character hex id). */
export function tokenAad(ownerId: string | { toHexString(): string }, igUserId: string): string {
  return `${typeof ownerId === "string" ? ownerId : ownerId.toHexString()}:${igUserId}`;
}

/** Read and check the encryption keys. Never returns or prints a key in a problem. */
export function readTokenKeys(env: NodeJS.ProcessEnv = process.env): TokenKeysResult {
  const raw = env[TOKEN_KEYS_ENV]?.trim() ?? "";
  const active = env[TOKEN_ACTIVE_VERSION_ENV]?.trim() ?? "";
  const problems: string[] = [];
  const keys = new Map<string, Buffer>();

  if (raw === "") {
    problems.push(`${TOKEN_KEYS_ENV} is missing. Add it to .env as {"1":"<key>"}. ${MAKE_KEY}`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${TOKEN_KEYS_ENV} must be JSON like {"1":"<key>"} on one line.`);
    } else {
      for (const [version, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!VERSION.test(version)) {
          problems.push(`${TOKEN_KEYS_ENV}: a key version must be a short name like "1" (letters, numbers, - or _).`);
          continue;
        }
        const text = typeof value === "string" ? value.trim() : "";
        const key = BASE64.test(text) ? Buffer.from(text, "base64") : null;
        if (!key || key.length !== KEY_BYTES) {
          problems.push(`${TOKEN_KEYS_ENV}: key "${version}" must be base64 of exactly 32 bytes. ${MAKE_KEY}`);
          continue;
        }
        keys.set(version, key);
      }
      if (keys.size === 0 && problems.length === 0) problems.push(`${TOKEN_KEYS_ENV} has no keys. ${MAKE_KEY}`);
    }
  }

  if (active === "") {
    problems.push(`${TOKEN_ACTIVE_VERSION_ENV} is missing. Set it to the version of the key to use, e.g. 1.`);
  } else if (problems.length === 0 && !keys.has(active)) {
    problems.push(`${TOKEN_ACTIVE_VERSION_ENV} names a version that ${TOKEN_KEYS_ENV} doesn't have.`);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, keys: { activeVersion: active, keys } };
}

/** Thrown when a token can't be decrypted (unknown key version, wrong key, another record, or changed data). */
export class TokenDecryptError extends Error {
  override name = "TokenDecryptError";
}

/** Encrypt with the ACTIVE key and a new random IV, bound to `aad` (use tokenAad). */
export function encryptToken(plain: string, keys: TokenKeys, aad: string): EncryptedToken {
  const key = keys.keys.get(keys.activeVersion);
  if (!key) throw new Error(`${TOKEN_ACTIVE_VERSION_ENV} names a version that ${TOKEN_KEYS_ENV} doesn't have.`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), keyVersion: keys.activeVersion };
}

/** Decrypt with the key of the record's own version and the same `aad`. A wrong key, another record or any changed byte fails. */
export function decryptToken(token: EncryptedToken, keys: TokenKeys, aad: string): string {
  const key = keys.keys.get(token.keyVersion);
  if (!key) throw new TokenDecryptError(`No key for version "${token.keyVersion}" in ${TOKEN_KEYS_ENV}.`);
  try {
    const iv = Buffer.from(token.iv, "base64");
    const tag = Buffer.from(token.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("bad sizes");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(token.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenDecryptError("The token could not be decrypted (wrong key, another record, or changed data).");
  }
}
