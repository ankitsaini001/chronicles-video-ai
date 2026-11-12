import { createHash } from "node:crypto";

/** Content hash in the form "sha256:<hex>". Used for plans and stored artifacts. */
export function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
