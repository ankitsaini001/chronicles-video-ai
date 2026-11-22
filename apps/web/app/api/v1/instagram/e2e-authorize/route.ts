import { CALLBACK_PATH } from "@/lib/instagram/config";
import { fakeAuthorizePage } from "@/lib/instagram/fake-instagram";
import { isFakeInstagram } from "@/lib/instagram/provider";

// The Instagram STAND-IN's login page (F28, tests only): exists only when E2E_FAKE_INSTAGRAM=1 is
// allowed (test database, local test port, not Vercel). Everywhere else: 404.

export function GET(request: Request): Response {
  if (!isFakeInstagram(process.env)) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  return new Response(fakeAuthorizePage(`${origin}${CALLBACK_PATH}`, state), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
