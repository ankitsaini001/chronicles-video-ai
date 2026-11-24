import { API_RATE_LIMITS, disconnectInstagram, getInstagramConnection } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { connectionStatus, disconnectConnection } from "@/lib/instagram/connection";

// G1 GET /api/v1/instagram/connection: the user's Instagram connection or null (F28).
// G4 DELETE /api/v1/instagram/connection: disconnect, the token is deleted at once (F28; 404 when
// nothing is connected). The token is never in an answer. F30: the user's scheduled / publish_failed
// posts lose their approval in the same transaction; refused (409) while a post is being published.

export const GET = apiRoute({
  rateLimit: API_RATE_LIMITS.readsPerUser,
  handle: ({ db, user }) => connectionStatus({ find: (id) => getInstagramConnection(db, id), disconnect: async () => null }, user.id),
});

export const DELETE = apiRoute({
  rateLimit: API_RATE_LIMITS.instagramDisconnectPerUser,
  handle: ({ db, user }) => disconnectConnection({ find: (id) => getInstagramConnection(db, id), disconnect: (id) => disconnectInstagram(db, id) }, user.id),
});
