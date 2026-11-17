import { afterEach, describe, expect, it, vi } from "vitest";
import { apiSend, CLIENT_MESSAGES, SEND_TIMEOUT_MS } from "../apps/web/components/storyboard/client";

// The browser helper for /api/v1 calls (F17–F26). F26 founder test: a server that never answers must
// not leave a button locked; the call gives up after SEND_TIMEOUT_MS with a plain TIMEOUT answer.

/** A fetch that never answers until the request is aborted (like a stuck dev server). */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("apiSend", () => {
  it("waits 30 s by default", () => {
    expect(SEND_TIMEOUT_MS).toBe(30_000);
  });

  it("gives up after the time limit with TIMEOUT (status 0, so the click keeps its Idempotency-Key)", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const pending = apiSend("POST", "/api/v1/projects/p/revisions", { message: "hi" }, { "Idempotency-Key": "k" });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, status: 0, code: "TIMEOUT", message: CLIENT_MESSAGES.TIMEOUT, details: undefined });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a custom time limit is honoured", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const pending = apiSend("GET", "/api/v1/x", undefined, {}, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).ok).toBe(false);
    expect((await pending) as { code: string }).toMatchObject({ code: "TIMEOUT" });
  });

  it("a network failure (not a timeout) is still OFFLINE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await apiSend("GET", "/api/v1/x")).toMatchObject({ ok: false, status: 0, code: "OFFLINE", message: CLIENT_MESSAGES.OFFLINE });
  });

  it("a quick answer is read as before (success JSON, error envelope, empty or non-JSON body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 202 })));
    expect(await apiSend("GET", "/api/v1/x")).toEqual({ ok: true, status: 202, json: { hello: "world" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "STALE_VERSION", message: "Changed.", details: { a: 1 } } }), { status: 409 })));
    expect(await apiSend("POST", "/api/v1/x", {})).toEqual({ ok: false, status: 409, code: "STALE_VERSION", message: "Changed.", details: { a: 1 } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await apiSend("DELETE", "/api/v1/x")).toEqual({ ok: true, status: 204, json: {} });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 502 })));
    expect(await apiSend("GET", "/api/v1/x")).toMatchObject({ ok: false, status: 502, code: "INTERNAL", message: CLIENT_MESSAGES.INTERNAL });
  });

  it("a 503 PROVIDER_BUSY keeps its own message; other 5xx show the generic one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "PROVIDER_BUSY", message: "Busy." } }), { status: 503 })));
    expect(await apiSend("POST", "/api/v1/x", {})).toMatchObject({ code: "PROVIDER_BUSY", message: "Busy." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "secret detail" } }), { status: 500 })));
    expect(await apiSend("POST", "/api/v1/x", {})).toMatchObject({ code: "INTERNAL", message: CLIENT_MESSAGES.INTERNAL });
  });
});
