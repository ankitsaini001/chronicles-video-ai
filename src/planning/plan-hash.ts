import type { Plan } from "../contracts";
import { sha256 } from "../shared/hash";

/**
 * Canonical plan hash (PIPELINE_DESIGN.md §5).
 *
 * Two plans that differ only in key order or in whitespace get the same hash.
 * Any meaningful change (a word, a scene, an ID, a voice) gives a different hash,
 * which makes any earlier approval stale.
 *
 * Canonical form:
 * - object keys sorted alphabetically (recursively); undefined values dropped
 * - strings Unicode-normalized (NFC), trimmed, inner whitespace runs collapsed to one space
 * - arrays keep their order (scene order is meaningful)
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("cannot hash a non-finite number");
  }
  return value; // number, boolean, null
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Hash of a schema-parsed plan. Always hash the parsed plan so defaults (null speech/display) are applied first. */
export function hashPlan(plan: Plan): string {
  return sha256(canonicalJson(plan));
}
