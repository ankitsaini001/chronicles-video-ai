import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

/** Remotion entry point (bundled by `npm run studio` and by the render stage). */
registerRoot(RemotionRoot);
