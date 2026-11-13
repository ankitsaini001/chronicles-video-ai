import { describe, expect, it } from "vitest";
import { toSessionUser } from "../apps/web/lib/auth/session";

// F09 review: every server-side session read requires status "active" (API.md §3.1).
// F11: the session user also carries the profile and defaults B1 needs, never the login-protection fields.

const createdAt = new Date("2026-11-12T04:30:00.000Z");
const user = {
  id: "67330c1a9f1e4b2a7c0d1e01",
  name: "Priya",
  email: "priya@example.com",
  status: "active",
  role: "creator",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  createdAt,
  failedLoginCount: 3,
  lockedUntil: null,
  lastLoginAt: createdAt,
};

const expected = {
  id: user.id,
  name: "Priya",
  email: "priya@example.com",
  role: "creator",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  createdAt: "2026-11-12T04:30:00.000Z",
};

describe("toSessionUser", () => {
  it("an active user's session gives the profile only (no login-protection fields)", () => {
    const result = toSessionUser({ user });
    expect(result).toEqual(expected);
    expect(Object.keys(result ?? {})).not.toContain("failedLoginCount");
  });

  it.each(["suspended", "deleting", undefined, "", "ACTIVE"])("status %j counts as signed out", (status) => {
    expect(toSessionUser({ user: { ...user, status } })).toBeNull();
  });

  it("no session counts as signed out", () => {
    expect(toSessionUser(null)).toBeNull();
    expect(toSessionUser(undefined)).toBeNull();
  });

  it("an admin stays an admin", () => {
    expect(toSessionUser({ user: { ...user, role: "admin" } })?.role).toBe("admin");
  });

  it("unexpected stored values fall back to safe defaults", () => {
    const odd = { ...user, role: "superuser", timezone: "India/Mumbai", defaultLanguage: "fr", defaultVoiceGender: 7, createdAt: "not a date" };
    expect(toSessionUser({ user: odd })).toEqual({
      ...expected,
      role: "creator",
      timezone: "Asia/Kolkata",
      defaultLanguage: "en",
      defaultVoiceGender: "female",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("keeps a valid non-default profile", () => {
    const other = { ...user, timezone: "Europe/London", defaultLanguage: "hinglish", defaultVoiceGender: "male" };
    expect(toSessionUser({ user: other })).toMatchObject({ timezone: "Europe/London", defaultLanguage: "hinglish", defaultVoiceGender: "male" });
  });
});
