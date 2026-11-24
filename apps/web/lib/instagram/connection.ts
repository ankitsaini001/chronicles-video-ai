import { InstagramBusyError, toInstagramConnectionResource, type InstagramConnectionDocument, type InstagramConnectionResource } from "@bytereel/db";
import { ApiProblem } from "../api/v1";

// G1 (connection status) and G4 (disconnect) (F28; API.md §14.7). The token is never part of an
// answer: the resource is built field by field (toInstagramConnectionResource). The database calls
// are passed in, so the tests run these with fakes.

export type ConnectionStore = {
  find(userId: string): Promise<InstagramConnectionDocument | null>;
  disconnect(userId: string): Promise<InstagramConnectionDocument | null>;
};

export const NO_CONNECTION_MESSAGE = "No Instagram account is connected.";

/** G1: the user's connection (any status: the page treats anything but `active` as not connected), or null. */
export async function connectionStatus(store: ConnectionStore, userId: string): Promise<{ connection: InstagramConnectionResource | null }> {
  const doc = await store.find(userId);
  return { connection: doc ? toInstagramConnectionResource(doc) : null };
}

/** G4: token removed, status `revoked`. Nothing connected → 404. A post being published right now → 409 (F30). */
export async function disconnectConnection(store: ConnectionStore, userId: string): Promise<{ connection: InstagramConnectionResource }> {
  let doc: InstagramConnectionDocument | null;
  try {
    doc = await store.disconnect(userId);
  } catch (error) {
    if (error instanceof InstagramBusyError) throw new ApiProblem(409, "INVALID_STATE", error.message, { reason: "post_publishing" });
    throw error;
  }
  if (!doc) throw new ApiProblem(404, "NOT_FOUND", NO_CONNECTION_MESSAGE);
  return { connection: toInstagramConnectionResource(doc) };
}

/** B1 `instagram`: the status and username; `not_connected` without a connection or after disconnecting. */
export function meInstagram(doc: Pick<InstagramConnectionDocument, "status" | "username"> | null): { status: "not_connected" | "active" | "expired" | "error"; username: string | null } {
  if (!doc || doc.status === "revoked") return { status: "not_connected", username: null };
  return { status: doc.status, username: doc.username };
}
