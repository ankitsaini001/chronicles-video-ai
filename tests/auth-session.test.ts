import { describe, expect, it } from "vitest";
import { toSessionUser } from "../apps/web/lib/auth/session";

// F09 review: every server-side session read requires status "active" (API.md §3.1).

const user = { id: "67330c1a9f1e4b2a7c0d1e01", name: "Priya", email: "priya@example.com", status: "active", role: "creator" };

describe("toSessionUser", () => {
  it("an active user's session gives only id, name and email", () => {
    expect(toSessionUser({ user })).toEqual({ id: user.id, name: "Priya", email: "priya@example.com" });
  });

  it.each(["suspended", "deleting", undefined, "", "ACTIVE"])("status %j counts as signed out", (status) => {
    expect(toSessionUser({ user: { ...user, status } })).toBeNull();
  });

  it("no session counts as signed out", () => {
    expect(toSessionUser(null)).toBeNull();
    expect(toSessionUser(undefined)).toBeNull();
  });
});
