import { ApprovalSchema, type Approval, type Plan } from "../contracts";
import { hashPlan } from "./plan-hash";

/**
 * Plan approval (PIPELINE_DESIGN.md §5). The approval stores the hash of exactly
 * what was reviewed. If the plan changes afterwards, the hashes differ and the
 * approval is stale: generation must not start until the new plan is approved.
 */

export function createApproval(plan: Plan, actor: string, now: Date): Approval {
  return ApprovalSchema.parse({ planHash: hashPlan(plan), actor, approvedAt: now.toISOString() });
}

export type ApprovalCheck =
  | { valid: true; planHash: string }
  | { valid: false; reason: string };

export function checkApproval(plan: Plan, approval: Approval | null | undefined): ApprovalCheck {
  if (!approval) return { valid: false, reason: "plan has not been approved yet" };
  const parsed = ApprovalSchema.safeParse(approval);
  if (!parsed.success) return { valid: false, reason: "approval record is malformed" };
  const currentHash = hashPlan(plan);
  if (parsed.data.planHash !== currentHash) {
    return {
      valid: false,
      reason:
        `stale approval: it was given for plan ${parsed.data.planHash}, but the current plan is ${currentHash}. ` +
        "The plan changed after approval; review and approve it again.",
    };
  }
  return { valid: true, planHash: currentHash };
}
