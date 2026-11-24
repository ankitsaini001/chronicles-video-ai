import { type Db, ObjectId } from "mongodb";
import { AUDIT_LOGS_COLLECTION } from "./collections";
import { hasPostInFlight, invalidateOpenPosts } from "./post-approval";
import type { EncryptedToken } from "./token-crypto";

// `instagramConnections` (DATABASE.md §4.21; F28): the creator's connected Instagram professional
// account and its ENCRYPTED token. Every function takes the signed-in user's id and puts it in
// every filter (§6.3). One connection per user (unique ownerId) and one active user per Instagram
// account (unique partial igUserId where status "active"), both ways (PRD #24d).
// The token is never returned by `toInstagramConnectionResource` and never written to the audit log.
//
// F30: connecting a DIFFERENT account and disconnecting turn the user's `scheduled` and
// `publish_failed` posts into `approval_invalidated` (+ a notification) inside the SAME transactions
// below (DATABASE.md §7.2 rows 13 and 14). Disconnect is refused (InstagramBusyError → 409
// INVALID_STATE) while one of the user's posts is being published (`publishing` / `outcome_unknown`).

export const INSTAGRAM_CONNECTIONS_COLLECTION = "instagramConnections";
export const INSTAGRAM_CONNECTION_SCHEMA_VERSION = 1;

/** Only professional accounts can publish through the API (ARCHITECTURE §17.2). */
export const INSTAGRAM_ACCOUNT_TYPES = ["BUSINESS", "MEDIA_CREATOR"] as const;
export type InstagramAccountType = (typeof INSTAGRAM_ACCOUNT_TYPES)[number];

export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;

export type InstagramConnectionStatus = "active" | "expired" | "revoked" | "error";

export interface InstagramConnectionDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  schemaVersion: number;
  igUserId: string;
  username: string;
  accountType: InstagramAccountType;
  profilePictureUrl: string | null;
  /** Removed when disconnected. */
  accessToken?: EncryptedToken;
  tokenExpiresAt: Date;
  lastRefreshedAt: Date;
  connectedAt: Date;
  revokedAt: Date | null;
  scopes: string[];
  status: InstagramConnectionStatus;
}

/** API.md §11.3 `InstagramConnection` (the token is never part of it). */
export type InstagramConnectionResource = {
  id: string;
  igUserId: string;
  username: string;
  accountType: InstagramAccountType;
  profilePictureUrl: string | null;
  status: InstagramConnectionStatus;
  tokenExpiresAt: string;
  connectedAt: string;
  lastRefreshedAt: string;
};

export function toInstagramConnectionResource(doc: InstagramConnectionDocument): InstagramConnectionResource {
  return {
    id: doc._id.toHexString(),
    igUserId: doc.igUserId,
    username: doc.username,
    accountType: doc.accountType,
    profilePictureUrl: doc.profilePictureUrl,
    status: doc.status,
    tokenExpiresAt: doc.tokenExpiresAt.toISOString(),
    connectedAt: doc.connectedAt.toISOString(),
    lastRefreshedAt: doc.lastRefreshedAt.toISOString(),
  };
}

/** Instagram's account_type ("Business", "Media_Creator", any case) → ours, or null for any other (personal). */
export function eligibleAccountType(value: unknown): InstagramAccountType | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return INSTAGRAM_ACCOUNT_TYPES.find((t) => t === upper) ?? null;
}

/** G4 while a post is being published (`publishing` / `outcome_unknown`): 409 INVALID_STATE, try again in a few minutes. */
export class InstagramBusyError extends Error {
  override name = "InstagramBusyError";
  constructor() {
    super("A post is being published to Instagram right now. You can disconnect in a few minutes.");
  }
}

/** This Instagram account already has an ACTIVE connection owned by another user (INSTAGRAM_ACCOUNT_IN_USE). */
export class InstagramAccountInUseError extends Error {
  override name = "InstagramAccountInUseError";
  constructor() {
    super("This Instagram account is already connected to another user.");
  }
}

const connections = (db: Db) => db.collection<InstagramConnectionDocument>(INSTAGRAM_CONNECTIONS_COLLECTION);

function ownerObjectId(ownerId: string | ObjectId): ObjectId {
  return typeof ownerId === "string" ? new ObjectId(ownerId) : ownerId;
}

/** The user's connection (any status), or null. */
export async function getInstagramConnection(db: Db, ownerId: string | ObjectId): Promise<InstagramConnectionDocument | null> {
  return connections(db).findOne({ ownerId: ownerObjectId(ownerId) });
}

export type InstagramConnectionToSave = {
  igUserId: string;
  username: string;
  accountType: InstagramAccountType;
  profilePictureUrl: string | null;
  accessToken: EncryptedToken;
  tokenExpiresAt: Date;
  scopes: string[];
};

function isDuplicateKey(error: unknown): error is { code: 11000; keyPattern?: Record<string, unknown> } {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * G3: save the connection (insert, or replace the user's earlier one) and audit
 * `instagram.connected`, in ONE transaction (DATABASE.md §7.2 row 13). Refused with
 * InstagramAccountInUseError when another user has this igUserId active: checked inside the
 * transaction, and the unique partial index catches two users finishing at the same moment.
 */
export async function saveInstagramConnection(db: Db, ownerId: string | ObjectId, input: InstagramConnectionToSave, now: Date = new Date()): Promise<InstagramConnectionDocument> {
  const owner = ownerObjectId(ownerId);
  // One retry: two callbacks of the SAME user at once can both try to insert (unique ownerId);
  // the second attempt finds the first one's document and replaces it.
  for (let attempt = 1; ; attempt++) {
    try {
      return await saveOnce(db, owner, input, now);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const onOwner = !!error.keyPattern && "ownerId" in error.keyPattern;
      if (onOwner && attempt === 1) continue;
      // A second duplicate on ownerId is not "another user's account": keep the real error.
      if (onOwner) throw error;
      throw new InstagramAccountInUseError();
    }
  }
}

async function saveOnce(db: Db, owner: ObjectId, input: InstagramConnectionToSave, now: Date): Promise<InstagramConnectionDocument> {
  const session = db.client.startSession();
  let saved: InstagramConnectionDocument | null = null;
  try {
    await session.withTransaction(async () => {
      const taken = await connections(db).findOne({ igUserId: input.igUserId, status: "active", ownerId: { $ne: owner } }, { session, projection: { _id: 1 } });
      if (taken) throw new InstagramAccountInUseError();
      const existing = await connections(db).findOne({ ownerId: owner }, { session });
      const doc: InstagramConnectionDocument = {
        _id: existing?._id ?? new ObjectId(),
        ownerId: owner,
        schemaVersion: INSTAGRAM_CONNECTION_SCHEMA_VERSION,
        igUserId: input.igUserId,
        username: input.username,
        accountType: input.accountType,
        profilePictureUrl: input.profilePictureUrl,
        accessToken: input.accessToken,
        tokenExpiresAt: input.tokenExpiresAt,
        lastRefreshedAt: now,
        connectedAt: now,
        revokedAt: null,
        scopes: input.scopes,
        status: "active",
      };
      if (existing) await connections(db).replaceOne({ _id: existing._id, ownerId: owner }, doc, { session });
      else await connections(db).insertOne(doc, { session });
      // F30: another Instagram account than before → posts approved for the old one can't publish.
      if (existing && existing.igUserId !== input.igUserId) {
        await invalidateOpenPosts(db, session, { ownerId: owner, reason: "instagram_account_changed", now });
      }
      await db.collection(AUDIT_LOGS_COLLECTION).insertOne(
        {
          schemaVersion: 1,
          actorId: owner,
          action: "instagram.connected",
          subject: { type: "instagramConnection", id: doc._id },
          data: { igUserId: input.igUserId, username: input.username, accountType: input.accountType, reconnected: existing !== null, sameAccount: existing?.igUserId === input.igUserId },
          at: now,
        },
        { session },
      );
      saved = doc;
    });
  } finally {
    await session.endSession();
  }
  if (!saved) throw new Error("The Instagram connection was not saved.");
  return saved;
}

/**
 * G4: remove the token, status `revoked`, `revokedAt`, audit `instagram.disconnected`, in ONE
 * transaction (DATABASE.md §7.2 row 14). Null when nothing is connected: no connection, or it was
 * already disconnected (nothing is written again). An `expired`/`error` connection is disconnected too.
 * F30: refused (InstagramBusyError) while a post is being published; the user's `scheduled` /
 * `publish_failed` posts → `approval_invalidated` (+ notification) in the same transaction.
 */
export async function disconnectInstagram(db: Db, ownerId: string | ObjectId, now: Date = new Date()): Promise<InstagramConnectionDocument | null> {
  const owner = ownerObjectId(ownerId);
  const session = db.client.startSession();
  let result: InstagramConnectionDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const existing = await connections(db).findOne({ ownerId: owner }, { session });
      if (!existing || existing.status === "revoked") return;
      if (await hasPostInFlight(db, { ownerId: owner }, session)) throw new InstagramBusyError();
      await invalidateOpenPosts(db, session, { ownerId: owner, reason: "instagram_disconnected", now });
      const updated = await connections(db).findOneAndUpdate(
        { _id: existing._id, ownerId: owner },
        { $set: { status: "revoked", revokedAt: now }, $unset: { accessToken: "" } },
        { session, returnDocument: "after" },
      );
      await db.collection(AUDIT_LOGS_COLLECTION).insertOne(
        { schemaVersion: 1, actorId: owner, action: "instagram.disconnected", subject: { type: "instagramConnection", id: existing._id }, data: { igUserId: existing.igUserId, username: existing.username }, at: now },
        { session },
      );
      result = updated;
    });
  } finally {
    await session.endSession();
  }
  return result;
}
