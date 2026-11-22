import { startConnect } from "@/lib/instagram/connect";
import { instagramFlowDeps } from "@/lib/instagram/server";

// G2 GET /api/v1/instagram/connect?returnTo=settings|publish:<projectId> (F28): a top-level browser
// navigation from "Connect Instagram". Signed state → 302 to Instagram's login page. Problems go
// back to the page as ?instagram_error=… (lib/instagram/connect.ts).

export function GET(request: Request): Promise<Response> {
  return startConnect(request, instagramFlowDeps());
}
