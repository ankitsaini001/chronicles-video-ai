// The Instagram post caption (F29; API.md H1, H7; DATABASE.md §4.8 `captionDraft`): the limits, the
// text cleaning and the length count, shared by the server and the Step 4 caption box (browser:
// "@bytereel/db/post-caption"). Pure: no database import.
// Not to be confused with the video's on-screen captions (F25, caption-fixes.ts / caption-messages.ts).

/**
 * Instagram's caption limit: "Maximum 2200 characters, 30 hashtags, and 20 @ tags" (Meta, IG User
 * Media reference, read 2026-11-24). The caption box and H7 allow up to 2,200 (hashtags included);
 * the AI's own caption stays at most 2,000 so its hashtags always fit (API.md H1).
 */
export const POST_CAPTION_LIMITS = {
  /** The whole text the creator posts: caption + hashtags (H2, H7). */
  textMax: 2200,
  /** The AI's caption part (H1). */
  aiCaptionMax: 2000,
  /** What the prompt asks for: short and hook-first. */
  aiCaptionAim: 300,
  /** Hashtags in an AI suggestion (founder decision 4: 3–5 focused ones). */
  hashtagsMin: 3,
  hashtagsMax: 5,
  /** Characters after the "#" (API.md H1). */
  hashtagCharsMax: 100,
  /** Instagram's own limit, checked again by H2 (F30). */
  instagramHashtagsMax: 30,
} as const;

/**
 * The length Instagram counts, as we count it everywhere (the counter, H7 and later H2): Unicode code
 * points, so an emoji such as "🌧" is 1, not the 2 UTF-16 units JavaScript's `.length` gives.
 */
export function postCaptionLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Cleans caption text before it is saved: Windows line ends → "\n", every other control character
 * (tab included) → a space, invisible format characters (bidi overrides, zero-width space, BOM …)
 * removed except ZWNJ/ZWJ (Devanagari and emoji sequences need them), then NFC. Line breaks stay:
 * a caption has paragraphs and the hashtags on their own line. Spaces are NOT trimmed here, so an
 * autosave while typing never moves the creator's cursor.
 */
export function cleanPostCaptionText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/(?!\n)\p{Cc}/gu, " ")
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .normalize("NFC");
}

/** The saved text of an AI suggestion: the caption, a blank line, the hashtags separated by spaces. */
export function joinPostCaption(caption: string, hashtags: readonly string[]): string {
  return hashtags.length > 0 ? `${caption}\n\n${hashtags.join(" ")}` : caption;
}

/** What the creator reads in the caption box (F29). Shown as is. */
export const POST_CAPTION_MESSAGES = {
  SUGGESTING: "Writing a caption for your video…",
  SAVED: "Saved",
  SAVING: "Saving…",
  NOT_SAVED: "Couldn't save your caption. Check your internet; we'll try again when you type.",
  TOO_LONG: "Instagram allows 2,200 characters. Please shorten your caption to save it.",
  CONFIRM_REPLACE: "Replace your caption with a new suggestion?",
  /** H1 answers (API.md §4.3). */
  PROVIDER_BUSY: "Our AI is busy or taking too long right now. Please try again in a few minutes, or write your own caption.",
  PROVIDER_REJECTED: "Our AI couldn't suggest a caption for this video. Please write your own.",
  QUOTA_EXCEEDED: "This project has used all 20 of its AI requests. You can still write your own caption.",
  NOT_CONNECTED: "Please connect your Instagram first.",
  NOT_READY: "This video can't be published right now. Please go back to your video.",
  DRAFT_EXISTS: "A caption is already saved for this video.",
} as const;
