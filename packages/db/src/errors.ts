import { redactConnectionString } from "./config";

// Turn MongoDB driver errors into plain sentences that say what to check.
// Never returns the connection string (it holds the password).

export interface ExplainedDbError {
  /** Short code for logs and tests. */
  code: "auth_failed" | "unreachable" | "dns_not_found" | "tls_failed" | "unknown";
  /** Plain message for the developer or founder. */
  message: string;
  /** The driver's own error name + message, with any connection string hidden. */
  detail: string;
}

export function explainDbError(error: unknown): ExplainedDbError {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const detail = redactConnectionString(`${name}: ${raw}`);
  const text = `${name} ${raw}`.toLowerCase();

  if (text.includes("authentication failed") || text.includes("bad auth") || (error as { code?: unknown })?.code === 18) {
    return {
      code: "auth_failed",
      message:
        "MongoDB refused the user name or password. Check MONGODB_URI in .env: the user and password must match Atlas → Database Access (special characters in the password must be URL-encoded).",
      detail,
    };
  }
  if (text.includes("querysrv enotfound") || text.includes("enotfound") || text.includes("getaddrinfo")) {
    return {
      code: "dns_not_found",
      message:
        "The cluster address in MONGODB_URI could not be found. Check the part after @ (e.g. bytereel-dev.xxxxx.mongodb.net) and your internet connection.",
      detail,
    };
  }
  if (text.includes("ssl") || text.includes("tls")) {
    return {
      code: "tls_failed",
      message: "The secure (TLS) connection to MongoDB failed. Check your internet connection or any proxy/firewall, then try again.",
      detail,
    };
  }
  if (name === "MongoServerSelectionError" || text.includes("server selection timed out") || text.includes("timed out")) {
    return {
      code: "unreachable",
      message:
        "Could not reach the MongoDB cluster within 10 seconds. Usually your current internet address is not on Atlas → Network Access (it changes when you switch Wi-Fi), or the cluster is paused (Atlas pauses free clusters after 30 days without connections).",
      detail,
    };
  }
  return { code: "unknown", message: "MongoDB returned an unexpected error. See the detail below.", detail };
}
