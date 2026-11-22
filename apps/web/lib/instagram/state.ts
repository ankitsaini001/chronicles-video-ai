import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// The OAuth `state` for Instagram login (F28; API.md G2/G3, ARCHITECTURE §17.2). Nothing is stored:
// the state carries { session binding, nonce, returnTo, expiry } and an HMAC-SHA256 signature with a
// key DERIVED from BETTER_AUTH_SECRET (HKDF, its own purpose label, so it is never the session key).
// It is bound to the login session that started it: the callback only accepts it with the same
// session cookie. The session id itself is not in the URL, only an HMAC of it.
// Format: base64url(JSON payload) + "." + base64url(signature).

/** How long the creator has on Instagram's page. */
export const STATE_TTL_SECONDS = 10 * 60;

export type ReturnTo = { kind: "settings" } | { kind: "publish"; projectId: string };

export type StatePayload = { s: string; n: string; r: string; e: number };

const RETURN_TO = /^(settings|publish:[a-f0-9]{24})$/;

/** `settings` or `publish:<projectId>` → ReturnTo; anything else → null. */
export function parseReturnTo(value: string | null | undefined): ReturnTo | null {
  const text = value ?? "settings";
  if (!RETURN_TO.test(text)) return null;
  return text === "settings" ? { kind: "settings" } : { kind: "publish", projectId: text.slice("publish:".length) };
}

export function formatReturnTo(returnTo: ReturnTo): string {
  return returnTo.kind === "settings" ? "settings" : `publish:${returnTo.projectId}`;
}

export function stateKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(authSecret, "utf8"), Buffer.alloc(0), Buffer.from("instagram-oauth-state-v1", "utf8"), 32));
}

function sessionBinding(key: Buffer, sessionId: string): string {
  return createHmac("sha256", key).update(`session:${sessionId}`, "utf8").digest("base64url").slice(0, 32);
}

export function signState(key: Buffer, sessionId: string, returnTo: ReturnTo, now: Date = new Date()): string {
  const payload: StatePayload = { s: sessionBinding(key, sessionId), n: randomBytes(16).toString("base64url"), r: formatReturnTo(returnTo), e: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body, "utf8").digest("base64url")}`;
}

/**
 * - `tampered`: no valid signature (forged or changed): its returnTo can't be trusted.
 * - `expired` / `other_session`: signed by us, so its returnTo is used for the way back.
 */
export type StateCheck = { ok: true; returnTo: ReturnTo } | { ok: false; reason: "tampered" } | { ok: false; reason: "expired" | "other_session"; returnTo: ReturnTo };

export function verifyState(key: Buffer, state: string, sessionId: string | null, now: Date = new Date()): StateCheck {
  const parts = state.split(".");
  if (parts.length !== 2 || state.length > 1024) return { ok: false, reason: "tampered" };
  const [body, signature] = parts as [string, string];
  const expected = createHmac("sha256", key).update(body, "utf8").digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "tampered" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "tampered" };
  }
  const returnTo = parseReturnTo(typeof payload.r === "string" ? payload.r : "");
  if (!returnTo || typeof payload.e !== "number" || typeof payload.s !== "string") return { ok: false, reason: "tampered" };
  if (payload.e * 1000 <= now.getTime()) return { ok: false, reason: "expired", returnTo };
  const binding = sessionId === null ? "" : sessionBinding(key, sessionId);
  const a = Buffer.from(binding);
  const b = Buffer.from(payload.s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "other_session", returnTo };
  return { ok: true, returnTo };
}
