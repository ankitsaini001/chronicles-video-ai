import { describe, expect, it } from "vitest";
import { API_RATE_LIMITS, DEFAULT_TIMEZONE, isValidTimezone, USAGE_LIMITS, usagePeriods } from "../packages/db/src/index";

// F11: the shared limits and the day / month periods (API.md §10.1, DATABASE.md §4.14).

describe("USAGE_LIMITS", () => {
  it("matches API.md §10.1", () => {
    expect(USAGE_LIMITS).toEqual({ videosPerDay: 3, projectsPerDay: 5, voiceCharactersPerMonth: 3000 });
  });

  it("B1 reads are limited to 300 per minute per user (API.md §10.3)", () => {
    expect(API_RATE_LIMITS.readsPerUser).toMatchObject({ limit: 300, windowSeconds: 60 });
  });
});

describe("usagePeriods", () => {
  it("Asia/Kolkata: resets at local midnight (18:30Z) and at the start of next month", () => {
    const p = usagePeriods("Asia/Kolkata", new Date("2026-11-13T10:00:00.000Z"));
    expect(p.day).toBe("2026-11-13");
    expect(p.month).toBe("2026-11");
    expect(p.dayResetsAt.toISOString()).toBe("2026-11-13T18:30:00.000Z");
    expect(p.monthResetsAt.toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });

  it("just after local midnight counts as the new day", () => {
    const p = usagePeriods("Asia/Kolkata", new Date("2026-11-13T18:30:00.000Z"));
    expect(p.day).toBe("2026-11-14");
    expect(p.dayResetsAt.toISOString()).toBe("2026-11-14T18:30:00.000Z");
  });

  it("just before local midnight is still today", () => {
    const p = usagePeriods("Asia/Kolkata", new Date("2026-11-13T18:29:59.000Z"));
    expect(p.day).toBe("2026-11-13");
  });

  it("the last day of the year rolls over into January", () => {
    const p = usagePeriods("Asia/Kolkata", new Date("2026-12-31T12:00:00.000Z"));
    expect(p.day).toBe("2026-12-31");
    expect(p.dayResetsAt.toISOString()).toBe("2026-12-31T18:30:00.000Z");
    expect(p.monthResetsAt.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });

  it("the 1st of the month in Kolkata while it is still the previous month in UTC", () => {
    const p = usagePeriods("Asia/Kolkata", new Date("2026-11-30T20:00:00.000Z"));
    expect(p.day).toBe("2026-12-01");
    expect(p.month).toBe("2026-12");
    expect(p.monthResetsAt.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });

  it("follows daylight saving time (New York, the night clocks go back)", () => {
    // 2026-11-01 is the change in the US: 00:00 EDT (−4) that day, 00:00 EST (−5) the next.
    const p = usagePeriods("America/New_York", new Date("2026-11-01T12:00:00.000Z"));
    expect(p.day).toBe("2026-11-01");
    expect(p.dayResetsAt.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(p.monthResetsAt.toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });

  it.each([
    // Clocks jump 00:00 → 01:00, so local midnight doesn't exist: the day starts at the jump.
    ["America/Santiago", "2026-09-05T12:00:00.000Z", "2026-09-06T04:00:00.000Z"],
    ["America/Havana", "2026-03-07T12:00:00.000Z", "2026-03-08T05:00:00.000Z"],
  ])("%s: when midnight is skipped, the next day starts at the first real moment", (zone, now, expected) => {
    const p = usagePeriods(zone, new Date(now));
    expect(p.dayResetsAt.toISOString()).toBe(expected);
    // That moment is already the next day, and one millisecond earlier is still today.
    expect(usagePeriods(zone, p.dayResetsAt).day).not.toBe(p.day);
    expect(usagePeriods(zone, new Date(p.dayResetsAt.getTime() - 1)).day).toBe(p.day);
  });

  it("America/Santiago, clocks go back at midnight: the day starts at the first 00:00", () => {
    const p = usagePeriods("America/Santiago", new Date("2026-04-04T12:00:00.000Z"));
    expect(p.dayResetsAt.toISOString()).toBe("2026-04-05T04:00:00.000Z");
  });

  it("UTC works too", () => {
    const p = usagePeriods("UTC", new Date("2026-02-28T23:59:00.000Z"));
    expect(p.dayResetsAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(p.monthResetsAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it.each(["", "India/Mumbai", "not a zone"])("unknown timezone %j falls back to Asia/Kolkata", (zone) => {
    const now = new Date("2026-11-13T10:00:00.000Z");
    expect(usagePeriods(zone, now)).toEqual(usagePeriods(DEFAULT_TIMEZONE, now));
  });

  it("isValidTimezone", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("India/Mumbai")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
