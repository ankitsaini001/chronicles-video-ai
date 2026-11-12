import { z } from "zod";
import { Sha256Schema, TimestampSchema } from "./common";

/**
 * Approval record (PIPELINE_DESIGN.md §5). Stored separately from the plan in approval.json.
 * It is only valid while `planHash` equals the canonical hash of the current plan,
 * so any meaningful plan edit automatically makes an old approval stale.
 */
export const ApprovalSchema = z.strictObject({
  planHash: Sha256Schema,
  /** Who approved: a creator or developer name/ID. Never the model. */
  actor: z.string().trim().min(1),
  approvedAt: TimestampSchema,
});
export type Approval = z.infer<typeof ApprovalSchema>;
