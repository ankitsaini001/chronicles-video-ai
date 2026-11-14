import { PAGE_LIMITS } from "@bytereel/db";
import { API_MESSAGES, ApiProblem } from "../api/v1";

// Shared pieces of the storyboard endpoints (D1–D8, F16–F20).

/**
 * `limit` (1–50, default 20) and `cursor` from a list query (API.md §5). Anything else in the query
 * is ignored; a bad `limit` or a repeated parameter → 400 INVALID_INPUT.
 */
export function pageQuery(url: URL, extra: readonly string[] = []): { limit: number; cursor: string | null } {
  const issues: { path: string; message: string }[] = [];
  for (const name of ["limit", "cursor", ...extra]) if (url.searchParams.getAll(name).length > 1) issues.push({ path: name, message: "must be given once" });
  const rawLimit = url.searchParams.get("limit");
  let limit: number = PAGE_LIMITS.default;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMITS.max) issues.push({ path: "limit", message: `must be a whole number from 1 to ${PAGE_LIMITS.max}` });
  }
  if (issues.length) throw new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, { issues });
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor === "" ? null : cursor };
}
