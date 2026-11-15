import { describe, expect, it } from "vitest";
import { hookCaptionStart, hookSlam } from "../packages/video/src/hook-words";

const words = (text: string) => text.split(" ").map((w, i) => ({ text: w, startFrame: i * 8, endFrame: i * 8 + 6, key: false }));
const slamOf = (text: string) => hookSlam(words(text)).slam.map((w) => w.text).join(" ");

describe("hook slam words end at a natural break (F22b review)", () => {
  it('keeps the approved water-cycle opening exactly: "Did you know…"', () => {
    const opening = words("Did you know that the water in your chai today might be the exact same water drunk by dinosaurs millions of years ago?");
    const { slam, end } = hookSlam(opening);
    expect(slam.map((w) => w.text)).toEqual(["Did", "you", "know"]);
    expect(end).toBe(opening[3]!.startFrame); // the captions take over at "that"
    expect(hookCaptionStart(opening)).toBe(end);
  });

  it("a short question, sentence or words up to a comma are a natural unit", () => {
    expect(slamOf("Ever wondered why? Most people never ask.")).toBe("Ever wondered why?");
    expect(slamOf("Rain is recycled. Every drop of it.")).toBe("Rain is recycled.");
    expect(slamOf("Imagine, just for a second, no internet.")).toBe("Imagine,");
    expect(slamOf("Have you ever wondered where your plastic bottle goes?")).toBe("Have you ever");
    expect(slamOf("What if your money could grow while you sleep?")).toBe("What if");
    expect(slamOf("Why? Because the sky is not really blue.")).toBe("Why?");
    expect(slamOf("Okay, ready? Let's start with a magnet.")).toBe("Okay, ready?");
  });

  it("a cut-off fragment is never shown: no slam words, the title is on screen from the first frame and the captions show every word", () => {
    for (const text of [
      "Should your monthly savings sit in a fixed deposit, or go into a SIP?",
      "When you press send on a chat message, how does it reach your friend?",
      "Where does rain come from, and where does it go after it falls?",
      // one word with a full stop or comma is a fragment too (second review)
      "Dr. Kalam once said that dreams are not what you see in sleep.",
      "So, what happens to a letter after you post it?",
      "Okay, picture a busy railway station at rush hour.",
    ]) {
      expect(hookSlam(words(text)), text).toEqual({ slam: [], end: 0 });
      expect(hookCaptionStart(words(text))).toBe(0);
    }
  });
});
