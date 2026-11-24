import type { ClientSession, Db, ObjectId } from "mongodb";

// In-app notifications (DATABASE.md §4.24; API.md B5/B6). F30 SAVES them, inside the same transaction
// as the event they report (§7): a post that went live (`post_published`), a post that failed
// (`post_failed`) and a post whose approval was cancelled by a change (`approval_invalidated`). The
// bell that shows them comes with F32. No imports from other modules here, so any module can use it
// without an import cycle.

export const NOTIFICATIONS_COLLECTION = "notifications";
export const NOTIFICATION_SCHEMA_VERSION = 1;

export type NotificationType =
  | "storyboard_ready"
  | "video_ready"
  | "needs_input"
  | "generate_failed"
  | "post_published"
  | "post_failed"
  | "approval_invalidated"
  | "instagram_reconnect";

export interface NotificationDocument {
  _id?: ObjectId;
  ownerId: ObjectId;
  schemaVersion: number;
  type: NotificationType;
  projectId: ObjectId | null;
  postId: ObjectId | null;
  title: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}

/** The plain words of each F30 notification (shown as is by the bell in F32). */
export const POST_NOTIFICATIONS = {
  approval_invalidated: (title: string) => ({
    title: "Please approve your post again",
    message: `"${title}" changed after you approved it, so it won't be posted. Check it and approve it again.`,
  }),
  post_published: (title: string, username: string) => ({ title: "Your reel is live", message: `"${title}" was posted to @${username}.` }),
  post_failed: (title: string) => ({ title: "Your post didn't go out", message: `"${title}" couldn't be posted to Instagram. Open it to see why and try again.` }),
} as const;

export function newNotification(input: { ownerId: ObjectId; type: NotificationType; projectId: ObjectId | null; postId: ObjectId | null; title: string; message: string; now: Date }): NotificationDocument {
  return {
    ownerId: input.ownerId,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    type: input.type,
    projectId: input.projectId,
    postId: input.postId,
    title: input.title,
    message: input.message,
    readAt: null,
    createdAt: input.now,
  };
}

/** Save notifications inside the caller's transaction (nothing when the list is empty). */
export async function insertNotifications(db: Db, session: ClientSession, docs: readonly NotificationDocument[]): Promise<void> {
  if (docs.length === 0) return;
  await db.collection<NotificationDocument>(NOTIFICATIONS_COLLECTION).insertMany([...docs], { session });
}
