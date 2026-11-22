import { setupFailed, startConnect } from "@/lib/instagram/connect";
import { instagramFlowDeps } from "@/lib/instagram/server";

// G2 GET /api/v1/instagram/connect?returnTo=settings|publish:<projectId> (F28): a top-level browser
// navigation from "Connect Instagram". Signed state → 302 to Instagram's login page. Problems go
// back to the page as ?instagram_error=… (lib/instagram/connect.ts); a setup that can't even be
// built (e.g. no database settings) goes back to My videos with reason=not_set_up.

export function GET(request: Request): Promise<Response> {
  let deps: ReturnType<typeof instagramFlowDeps>;
  try {
    deps = instagramFlowDeps();
  } catch (error) {
    return Promise.resolve(setupFailed(request, error));
  }
  return startConnect(request, deps);
}
