// Collection names shared by modules that would otherwise import each other (F16–F20 review):
// plan-versions.ts reads approvals, storyboard-approvals.ts reads plan versions. No imports here,
// so there is no import cycle at runtime.

export const PLAN_VERSIONS_COLLECTION = "planVersions";
export const STORYBOARD_APPROVALS_COLLECTION = "storyboardApprovals";
export const AUDIT_LOGS_COLLECTION = "auditLogs";
