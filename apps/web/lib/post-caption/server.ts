import { CAPTION_EDIT_STATES, findProjectRender, getInstagramConnection, getOwnedProject, getProjectPlanVersion, toCaptionDraftResource, type ProjectDocument, type RenderDocument } from "@bytereel/db";
import type { Db } from "mongodb";
import { storyboardChangedSince } from "../video/review-state";
import type { CaptionTarget } from "./handler";

// F29: what H1 reads about the project (server only), owner-scoped: the video is "ready to publish" by
// the same rule as the Step 4 page (video_ready, the current render ready, made from the current
// storyboard version: storyboardChangedSince), the approved storyboard's title and narration, and
// whether Instagram is connected (an `active` connection). F30 (decision 1): also `publish_failed`
// (the caption stays editable after a failed post; a change cancels its approval).

/** The project's video when it can be published from Step 4, else null (the publish page's own rule). */
export async function publishableRender(db: Db, project: ProjectDocument): Promise<RenderDocument | null> {
  if (!CAPTION_EDIT_STATES.includes(project.state) || project.currentRenderId === null) return null;
  const render = await findProjectRender(db, project, "current");
  if (!render || render.status !== "ready") return null;
  if (storyboardChangedSince({ state: project.state, currentPlanVersionId: project.currentPlanVersionId, renderPlanVersionId: render.planVersionId })) return null;
  return render;
}

export async function loadCaptionTarget(db: Db, ownerId: string, projectId: string): Promise<CaptionTarget | null> {
  const project = await getOwnedProject(db, ownerId, projectId);
  if (!project) return null;
  const [render, connection] = await Promise.all([publishableRender(db, project), getInstagramConnection(db, ownerId)]);
  const version = render ? await getProjectPlanVersion(db, project, render.planVersionId.toHexString()) : null;
  return {
    language: project.language,
    readyRenderId: render ? render._id.toHexString() : null,
    // The storyboard the video was made from (approved): its title as the creator sees it, and every
    // scene's narration joined into one text per scene.
    script: version ? { title: project.title, scenes: version.plan.scenes.map((scene) => scene.narration.map((n) => n.text).join(" ")) } : null,
    instagramActive: connection?.status === "active",
    draft: project.captionDraft ? toCaptionDraftResource(project.captionDraft) : null,
  };
}
