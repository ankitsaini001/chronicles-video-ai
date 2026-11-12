import { z } from "zod";
import {
  NarrationBlockSchema,
  PLAN_SCHEMA_VERSION,
  PlanSchema,
  PlanWarningSchema,
  SceneEventSchema,
  SceneSchema,
  VisualObjectSchema,
  type Language,
  type PlanInput,
  type Source,
  type VoicePreset,
} from "../contracts";
import { COMPONENT_CATALOG } from "./component-catalog";
import { ICON_NAMES } from "./icon-catalog";

/** Planner-only icon value meaning "no icon" (dropped by assemblePlan; plans never contain it). */
export const NO_ICON = "none";

/**
 * Planner-output contract (PIPELINE_DESIGN.md §5): the part of a plan the MODEL writes.
 *
 * It is derived from PlanSchema by removing everything application code owns:
 * - ownership and lineage (projectId, ownerId, versionId, parentVersionId) and schemaVersion,
 * - the creator's choices (language, voicePreset) and the user-provided sources (no invented citations),
 * - and, by construction, approval data and filesystem paths (the plan contract has neither).
 *
 * The model's JSON is never trusted as-is: `assemblePlan` drops any reserved field the model
 * returned anyway, fills the code-owned fields, and the result goes through the full plan
 * validation (schema + semantic rules).
 */

/** Plan fields assigned by application code. The model must not set them. */
export const CODE_OWNED_PLAN_FIELDS = [
  "schemaVersion",
  "projectId",
  "ownerId",
  "versionId",
  "parentVersionId",
  "language",
  "voicePreset",
  "sources",
] as const;

/**
 * Fields a model might invent that must never come from it: the code-owned plan fields plus
 * approval and path-like fields. They are dropped (and reported) before validation.
 */
export const RESERVED_MODEL_FIELDS: readonly string[] = [
  ...CODE_OWNED_PLAN_FIELDS,
  "approval",
  "approved",
  "approvedAt",
  "approvedBy",
  "planHash",
  "path",
  "paths",
  "outputPath",
  "runDir",
  "runId",
];

const unique = (values: string[]) => [...new Set(values)];
/** Every object kind / event action in the catalog. Per-pattern rules are checked by semantic validation. */
export const ALL_OBJECT_KINDS = unique(Object.values(COMPONENT_CATALOG).flatMap((rule) => Object.keys(rule.kinds)));
export const ALL_EVENT_ACTIONS = unique(Object.values(COMPONENT_CATALOG).flatMap((rule) => [...rule.actions]));

const PlannerNarrationSchema = NarrationBlockSchema.extend({
  text: NarrationBlockSchema.shape.text.describe("Approved narration wording, spoken and shown as captions."),
  speech: NarrationBlockSchema.shape.speech.describe("Pronunciation hint sent to text-to-speech when it must differ from text; otherwise null."),
  display: NarrationBlockSchema.shape.display.describe("Caption text when it must differ from text; otherwise null."),
});

const PlannerObjectSchema = VisualObjectSchema.extend({
  label: VisualObjectSchema.shape.label.describe(
    "Short, human-readable on-screen text (a title, name or phrase a viewer reads). Never a list of icon search words.",
  ),
  icon: z
    .enum([...ICON_NAMES, NO_ICON])
    .describe(`Picture drawn for this object, chosen from the icon set; "${NO_ICON}" when no icon fits or the kind has no picture.`),
  kind: z.enum(ALL_OBJECT_KINDS as [string, ...string[]]).describe("Object kind; must be allowed for the scene's pattern."),
  value: VisualObjectSchema.shape.value.describe("Number for chart kinds (bar, line-point, pie-slice, counter); null for every other kind."),
});

const PlannerEventSchema = SceneEventSchema.extend({
  action: z.enum(ALL_EVENT_ACTIONS as [string, ...string[]]).describe("Event action; must be allowed for the scene's pattern."),
  anchor: SceneEventSchema.shape.anchor.describe(
    "The exact words (copied verbatim from the narration block's text, whole words, appearing once) that trigger this event.",
  ),
});

const PlannerSceneSchema = SceneSchema.extend({
  narration: z.array(PlannerNarrationSchema).min(1),
  objects: z.array(PlannerObjectSchema),
  events: z.array(PlannerEventSchema),
});

export const PlannerOutputSchema = PlanSchema.omit({
  schemaVersion: true,
  projectId: true,
  ownerId: true,
  versionId: true,
  parentVersionId: true,
  language: true,
  voicePreset: true,
  sources: true,
}).extend({
  scenes: z.array(PlannerSceneSchema).min(2).max(12),
  warnings: z.array(PlanWarningSchema).describe("Uncertain, simplified or unsupported content a human reviewer should check."),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ---------- JSON schema for the provider ----------

/**
 * JSON Schema keywords kept for the provider's structured-output schema. Others are dropped.
 * `minItems` / `maxItems` are deliberately NOT sent: gemini-3.6-flash rejects this schema with
 * 400 INVALID_ARGUMENT when they are present (verified 2026-11-12). Array-length limits are still
 * enforced by our own validation afterwards, and violations go through the repair attempt.
 */
const KEPT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "minimum",
  "maximum",
  "description",
  "propertyOrdering",
]);

/**
 * Convert the planner-output Zod schema to a conservative JSON Schema for structured output.
 * Keeps only widely supported keywords (patterns and string lengths are enforced by our own
 * validation afterwards), turns `anyOf [X, null]` into a nullable type, marks every property
 * required and records property order so the model writes fields in a predictable order.
 */
export function plannerOutputJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(PlannerOutputSchema, { io: "output", unrepresentable: "throw" }) as Record<string, unknown>;
  return simplify(raw) as Record<string, unknown>;
}

function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;

  // anyOf [ {type: X, ...}, {type: "null"} ]  ->  {type: [X, "null"], ...}
  const anyOf = source.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nonNull = anyOf.find((s) => (s as { type?: unknown }).type !== "null") as Record<string, unknown> | undefined;
    const hasNull = anyOf.some((s) => (s as { type?: unknown }).type === "null");
    if (nonNull && hasNull && typeof nonNull.type === "string") {
      const merged: Record<string, unknown> = { ...nonNull, type: [nonNull.type, "null"] };
      if (typeof source.description === "string") merged.description = source.description;
      return simplify(merged);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KEPT_KEYWORDS.has(key)) continue;
    if (key === "properties") {
      const props = value as Record<string, unknown>;
      out.properties = Object.fromEntries(Object.entries(props).map(([name, schema]) => [name, simplify(schema)]));
      out.required = Object.keys(props);
      out.propertyOrdering = Object.keys(props);
    } else if (key !== "required" && key !== "propertyOrdering") {
      out[key] = simplify(value);
    }
  }
  return out;
}

// ---------- assembling a full plan ----------

export interface CodeOwnedPlanFields {
  ownerId: string;
  projectId: string;
  versionId: string;
  parentVersionId: string | null;
  language: Language;
  voicePreset: VoicePreset;
  sources: Source[];
}

export interface AssembledPlan {
  /** Full plan input, ready for validatePlan. */
  plan: PlanInput | Record<string, unknown>;
  /** Reserved fields the model returned and that were ignored. */
  ignoredFields: string[];
}

/**
 * Build a full plan from the model's output: reserved fields the model returned are dropped and
 * reported, and every code-owned field comes from application code. Other unexpected fields are
 * kept so strict validation reports them.
 */
export function assemblePlan(modelOutput: unknown, owned: CodeOwnedPlanFields): AssembledPlan {
  const body: Record<string, unknown> =
    modelOutput !== null && typeof modelOutput === "object" && !Array.isArray(modelOutput)
      ? { ...(modelOutput as Record<string, unknown>) }
      : {};
  const ignoredFields: string[] = [];
  for (const field of RESERVED_MODEL_FIELDS) {
    if (Object.hasOwn(body, field)) {
      ignoredFields.push(field);
      delete body[field];
    }
  }
  normalizeIcons(body);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    ownerId: owned.ownerId,
    projectId: owned.projectId,
    versionId: owned.versionId,
    parentVersionId: owned.parentVersionId,
    language: owned.language,
    voicePreset: owned.voicePreset,
    sources: owned.sources,
    ...body,
  };
  return { plan, ignoredFields };
}

/** The planner says "none" (or null) for "no icon"; the plan contract simply leaves `icon` out. */
function normalizeIcons(body: Record<string, unknown>): void {
  if (!Array.isArray(body.scenes)) return;
  for (const scene of body.scenes) {
    const objects = (scene as { objects?: unknown } | null)?.objects;
    if (!Array.isArray(objects)) continue;
    for (const object of objects) {
      if (object && typeof object === "object" && Object.hasOwn(object, "icon")) {
        const record = object as Record<string, unknown>;
        if (record.icon === NO_ICON || record.icon === null || record.icon === undefined) delete record.icon;
      }
    }
  }
}
