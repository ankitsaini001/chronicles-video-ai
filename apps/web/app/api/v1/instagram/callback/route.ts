import { finishConnect, setupFailed } from "@/lib/instagram/connect";
import { instagramFlowDeps } from "@/lib/instagram/server";

// G3 GET /api/v1/instagram/callback (F28): Instagram sends the creator back here. The state must be
// ours and bound to this login session; then code → token → long-lived token → profile, Creator or
// Business only, one Instagram account per user both ways, saved encrypted (lib/instagram/connect.ts).
// Always a redirect back to the page the creator came from, with a plain result in the query; a
// setup that can't even be built goes back to My videos with reason=not_set_up.

export function GET(request: Request): Promise<Response> {
  let deps: ReturnType<typeof instagramFlowDeps>;
  try {
    deps = instagramFlowDeps();
  } catch (error) {
    return Promise.resolve(setupFailed(request, error));
  }
  return finishConnect(request, deps);
}
