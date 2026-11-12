import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIDEO_ENTRY } from "../packages/pipeline/src/pipeline/render";

// render.ts finds the Remotion entry by file path (packages/video/src/index.ts). No other test
// touches that path, so a folder move would only fail at real render time. Guard it here.
describe("VIDEO_ENTRY", () => {
  it("points at the Remotion entry file in packages/video", () => {
    expect(VIDEO_ENTRY.replaceAll("\\", "/")).toMatch(/packages\/video\/src\/index\.ts$/);
    expect(existsSync(VIDEO_ENTRY)).toBe(true);
  });
});
