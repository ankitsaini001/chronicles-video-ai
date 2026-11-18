// What the creator reads about caption fixes (F25), shared by the server (caption-fixes.ts) and the
// Captions tab, which checks a fix before sending it (browser: "@bytereel/db/caption-messages").
// Pure: no database import.

export const CAPTION_MESSAGES = {
  WAITING: "Waiting to start…",
  UPDATING: "Updating captions…",
  CHECKING: "Checking the video…",
  SAVING: "Saving your video…",
  DONE: "Your captions are fixed.",
  CANCELLED: "Cancelled. Your video wasn't changed.",
  TOO_LONG: "This caption is too long to fit on screen. Please shorten it.",
  EMOJI: "Emoji can't be used in captions.",
  EMPTY: "Please write the caption, or press Undo.",
  NOTHING_CHANGED: "These captions already read like this.",
} as const;
