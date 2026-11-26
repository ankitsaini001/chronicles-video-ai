import { decryptToken, readTokenKeys, tokenAad, type InstagramConnectionDocument } from "@bytereel/db";

// The creator's Instagram token in plain text, for the publish job and "Check again" (F30). Decrypted
// with its record binding (`${ownerId}:${igUserId}`). Never logged, stored or returned. Throws when the
// keys aren't set up or the token can't be read (another key, a changed record).

export function connectionToken(connection: InstagramConnectionDocument): string {
  const keys = readTokenKeys(process.env);
  if (!keys.ok) throw new Error("The token keys are not set up.");
  if (!connection.accessToken) throw new Error("The connection has no token.");
  return decryptToken(connection.accessToken, keys.keys, tokenAad(connection.ownerId, connection.igUserId));
}
