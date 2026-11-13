import { describe, expect, it } from "vitest";
import { REQUEST_ACCESS_BODY, REQUEST_ACCESS_SUBJECT, requestAccessHref } from "../apps/web/lib/request-access";
import { SITE } from "../apps/web/lib/site";

describe("requestAccessHref (F10)", () => {
  it("is a mailto link to the team's contact email", () => {
    const href = requestAccessHref();
    expect(href.startsWith(`mailto:${SITE.contactEmail}?`)).toBe(true);
  });

  it("fills in the subject and message, encoded so mail apps read them back exactly", () => {
    const url = new URL(requestAccessHref("team@example.com"));
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("team@example.com");
    const params = new URLSearchParams(url.search.replace(/\+/g, "%2B"));
    expect(params.get("subject")).toBe(REQUEST_ACCESS_SUBJECT);
    expect(params.get("body")).toBe(REQUEST_ACCESS_BODY);
  });

  it("uses the product name from SITE, never a hard-coded one", () => {
    expect(REQUEST_ACCESS_SUBJECT).toContain(SITE.name);
    expect(REQUEST_ACCESS_BODY).toContain(SITE.name);
  });

  it("never carries anything but the subject and message (no email of the visitor)", () => {
    const params = new URLSearchParams(new URL(requestAccessHref()).search);
    expect([...params.keys()]).toEqual(["subject", "body"]);
  });
});
