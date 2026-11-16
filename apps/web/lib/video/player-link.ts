// The Step 3 player's two decisions about its private video link (F24), kept free of React so they
// can be unit-tested (tests/review-video.test.ts):
//   1. After the player fails: renew the link (go on at the same second, playing if it was), or give
//      up when the last link was applied less than 10 seconds ago (that fresh link failed too: no
//      endless loop). The time counts from when a link was APPLIED, not from when the error happened,
//      so a slow server can't cause a renewal every 10 seconds.
//   2. Which answer counts: link requests are numbered; only the newest one's answer is applied (a
//      quick switch to another version makes the older answer stale).

export const RENEW_AGAIN_AFTER_MS = 10_000;

/** Where the player goes on once the new link has loaded. */
export type Resume = { time: number; play: boolean };

export type AfterPlayerError = { action: "renew"; resume: Resume } | { action: "give_up" };

/** `lastAppliedAt` = when the current link was applied (0 = the page's first link, never renewed). */
export function afterPlayerError(input: { now: number; lastAppliedAt: number; currentTime: number; paused: boolean }): AfterPlayerError {
  if (input.lastAppliedAt > 0 && input.now - input.lastAppliedAt < RENEW_AGAIN_AFTER_MS) return { action: "give_up" };
  return { action: "renew", resume: { time: input.currentTime, play: !input.paused } };
}

/** Numbers the link requests; only the newest one's answer counts. */
export class LinkRequests {
  private latest = 0;

  /** A new request (any older one still on its way becomes stale). */
  start(): number {
    this.latest += 1;
    return this.latest;
  }

  isLatest(request: number): boolean {
    return request === this.latest;
  }
}
