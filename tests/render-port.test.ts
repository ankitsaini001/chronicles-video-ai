import { describe, expect, it } from "vitest";
import { DEFAULT_REMOTION_SERVE_PORT, remotionServePort } from "../packages/pipeline/src/pipeline/render";

// Remotion's bundle server port while rendering (packages/pipeline/src/pipeline/render.ts). Without a
// port Remotion takes the first free one from 3000 — the founder's dev site — so a port is always given.

describe("remotionServePort", () => {
  it("defaults to 3200: outside Remotion's own 3000–3100 search, never the dev site's 3000", () => {
    expect(DEFAULT_REMOTION_SERVE_PORT).toBe(3200);
    expect(remotionServePort({})).toBe(3200);
    expect(remotionServePort({ REMOTION_SERVE_PORT: "  " })).toBe(3200);
  });

  it("uses REMOTION_SERVE_PORT (the e2e servers use 3240–3249)", () => {
    expect(remotionServePort({ REMOTION_SERVE_PORT: "3240" })).toBe(3240);
    expect(remotionServePort({ REMOTION_SERVE_PORT: " 3249 " })).toBe(3249);
  });

  it("refuses the dev site (3000), the Inngest Dev Server (8288) and anything that isn't a usable port", () => {
    expect(() => remotionServePort({ REMOTION_SERVE_PORT: "3000" })).toThrow(/can't be 3000/);
    expect(() => remotionServePort({ REMOTION_SERVE_PORT: "8288" })).toThrow(/can't be 8288/);
    for (const bad of ["80", "70000", "abc", "3240.5", "-3240", "3 240"]) expect(() => remotionServePort({ REMOTION_SERVE_PORT: bad })).toThrow(/REMOTION_SERVE_PORT must be/);
  });
});
