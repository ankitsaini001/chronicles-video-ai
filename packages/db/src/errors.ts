import { redactConnectionString } from "./config";

// Turn MongoDB driver errors into plain sentences that say what to check.
// Never returns the connection string (it holds the password).

export interface ExplainedDbError {
  /** Short code for logs and tests. */
  code: "auth_failed" | "bad_uri" | "unreachable" | "dns_not_found" | "tls_failed" | "index_conflict" | "unknown";
  /** Plain message for the developer or founder. */
  message: string;
  /** The driver's own error name + message, with any connection string hidden. */
  detail: string;
}

/** Thrown by `ensureIndexes` when Atlas already has a different index in the way. */
export class IndexConflictError extends Error {
  override name = "IndexConflictError";
}

const ENCODE_HINT = "special characters in the password must be URL-encoded (@ → %40, / → %2F, : → %3A, # → %23, ? → %3F)";

/** `secrets`: values to mask in the detail as well (e.g. the configured password). */
export function explainDbError(error: unknown, secrets: readonly string[] = []): ExplainedDbError {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const detail = redactConnectionString(`${name}: ${raw}`, secrets);
  const text = `${name} ${raw}`.toLowerCase();
  const code = (error as { code?: unknown } | null)?.code;

  if (error instanceof IndexConflictError) return { code: "index_conflict", message: raw, detail };

  if (text.includes("authentication failed") || text.includes("bad auth") || code === 18) {
    return {
      code: "auth_failed",
      message: `MongoDB refused the user name or password. Check MONGODB_URI in .env: the user and password must match Atlas → Database Access, and ${ENCODE_HINT}.`,
      detail,
    };
  }
  // Invalid connection string or option: the driver rejects it before connecting.
  if (name === "MongoParseError" || name === "MongoInvalidArgumentError" || name === "MongoAPIError" || text.includes("invalid connection string")) {
    return { code: "bad_uri", message: `MONGODB_URI is not a valid connection string. Copy it again from Atlas → Connect → Drivers; ${ENCODE_HINT}.`, detail };
  }
  // mongodb+srv needs a special DNS lookup ("SRV"); some home routers and ISPs block or time it out.
  if (text.includes("querysrv") || text.includes("querytxt")) {
    return {
      code: "dns_not_found",
      message:
        "The cluster address in MONGODB_URI could not be looked up. Check the part after @ (e.g. bytereel-dev.xxxxx.mongodb.net) and your internet. If it is correct, your router/ISP may block this kind of lookup: try another network or DNS server (e.g. 8.8.8.8).",
      detail,
    };
  }
  if (text.includes("enotfound") || text.includes("getaddrinfo")) {
    return { code: "dns_not_found", message: "The cluster address in MONGODB_URI could not be found. Check the part after @ and your internet connection.", detail };
  }
  // Checked BEFORE the TLS text: on Atlas, a computer that isn't on Network Access usually fails as a
  // server-selection timeout carrying a TLS alert.
  if (name === "MongoServerSelectionError" || text.includes("server selection timed out")) {
    return {
      code: "unreachable",
      message:
        "Could not reach the MongoDB cluster within 10 seconds. Usually your current internet address is not on Atlas → Network Access (it changes when you switch Wi-Fi), or the cluster is paused (Atlas pauses free clusters after 30 days without connections).",
      detail,
    };
  }
  if (/\b(ssl|tls)\b.*\b(alert|handshake|certificate|routines)\b/.test(text)) {
    return {
      code: "tls_failed",
      message:
        "The secure (TLS) connection to MongoDB failed. First check that your internet address is on Atlas → Network Access; otherwise check any proxy/firewall, then try again.",
      detail,
    };
  }
  return { code: "unknown", message: "MongoDB returned an unexpected error. See the detail below.", detail };
}
