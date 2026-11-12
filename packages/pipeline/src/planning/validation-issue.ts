/** One validation problem, written for a human: which scene, which field, what is wrong. */
export interface ValidationIssue {
  /** Scene ID when the problem is inside a scene, otherwise null. */
  sceneId: string | null;
  /** JSON path to the field, e.g. "scenes[2].events[0].anchor.phrase". */
  path: string;
  message: string;
}

export function formatIssue(issue: ValidationIssue): string {
  const where = issue.sceneId ? `scene "${issue.sceneId}" > ${issue.path}` : issue.path || "(plan)";
  return `${where}: ${issue.message}`;
}
