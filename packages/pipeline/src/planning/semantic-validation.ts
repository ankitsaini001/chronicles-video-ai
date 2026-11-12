import type { Language, Plan, Scene } from "../contracts";
import { VOICE_PRESETS_BY_LANGUAGE } from "../contracts";
import { COMPONENT_CATALOG, PLAN_LIMITS, SCENE_LIMITS, WORDS_PER_MINUTE } from "./component-catalog";
import { looksLikeKeywordList } from "./icon-catalog";
import type { ValidationIssue } from "./validation-issue";

/**
 * Semantic validation (PIPELINE_DESIGN.md §5): rules that a JSON schema cannot express.
 * Runs on a plan that already passed PlanSchema. Returns every problem found, not just the first,
 * so a reviewer can fix them all in one go.
 */

export interface PlanStats {
  sceneCount: number;
  wordCount: number;
  estimatedSeconds: number;
}

export interface SemanticResult {
  issues: ValidationIssue[];
  /** Non-blocking review warnings (e.g. a label that reads like icon keywords). Never change the plan hash. */
  warnings: ValidationIssue[];
  stats: PlanStats;
}

export function validatePlanSemantics(plan: Plan): SemanticResult {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const add = (sceneId: string | null, path: string, message: string) => issues.push({ sceneId, path, message });

  checkSceneOrder(plan, add);
  checkVoiceMatchesLanguage(plan, add);
  checkUniqueIds(plan, add);
  plan.scenes.forEach((scene, index) => checkScene(scene, `scenes[${index}]`, plan.language, add));
  plan.scenes.forEach((scene, index) => warnLabels(scene, `scenes[${index}]`, (path, message) => warnings.push({ sceneId: scene.id, path, message })));
  checkWarningsAndSources(plan, add);

  const stats = estimateDuration(plan);
  const min = PLAN_LIMITS.targetMinSeconds * (1 - PLAN_LIMITS.estimateTolerance);
  const max = PLAN_LIMITS.targetMaxSeconds * (1 + PLAN_LIMITS.estimateTolerance);
  if (stats.estimatedSeconds < min || stats.estimatedSeconds > max) {
    add(
      null,
      "scenes",
      `estimated narration length is ${stats.estimatedSeconds} s (${stats.wordCount} words at ` +
        `${WORDS_PER_MINUTE[plan.language]} words/min); a 60-90 s video needs roughly ` +
        `${wordsFor(min, plan.language)}-${wordsFor(max, plan.language)} words. ` +
        (stats.estimatedSeconds < min ? "Expand the explanation (never add filler)." : "Shorten the narration."),
    );
  }

  return { issues, warnings, stats };
}

/** Labels are on-screen text; a label that reads like icon search words is flagged for review. */
function warnLabels(scene: Scene, path: string, warn: (path: string, message: string) => void): void {
  scene.objects.forEach((obj, i) => {
    if (looksLikeKeywordList(obj.label)) {
      warn(
        `${path}.objects[${i}].label`,
        `label "${obj.label}" looks like a list of icon keywords, not on-screen text; it is shown to viewers as written. ` +
          `Use a short readable label and put the picture in "icon".`,
      );
    }
  });
}

type AddIssue = (sceneId: string | null, path: string, message: string) => void;

function checkSceneOrder(plan: Plan, add: AddIssue): void {
  const count = plan.scenes.length;
  if (count < PLAN_LIMITS.minScenes || count > PLAN_LIMITS.maxScenes) {
    add(null, "scenes", `plan has ${count} scenes; it must have between ${PLAN_LIMITS.minScenes} and ${PLAN_LIMITS.maxScenes}`);
  }
  const first = plan.scenes[0];
  const last = plan.scenes[count - 1];
  if (first && first.type !== "title-hook") {
    add(first.id, "scenes[0].type", `the first scene must be "title-hook", but it is "${first.type}"`);
  }
  if (last && last.type !== "takeaway") {
    add(last.id, `scenes[${count - 1}].type`, `the last scene must be "takeaway", but it is "${last.type}"`);
  }
}

function checkVoiceMatchesLanguage(plan: Plan, add: AddIssue): void {
  const allowed = VOICE_PRESETS_BY_LANGUAGE[plan.language];
  if (!allowed.includes(plan.voicePreset)) {
    add(
      null,
      "voicePreset",
      `voice preset "${plan.voicePreset}" does not match language "${plan.language}"; use one of: ${allowed.join(", ")}`,
    );
  }
}

/** Scene IDs and narration IDs must be unique across the whole plan (they are stable references). */
function checkUniqueIds(plan: Plan, add: AddIssue): void {
  const sceneIds = new Set<string>();
  const narrationIds = new Set<string>();
  plan.scenes.forEach((scene, sIndex) => {
    if (sceneIds.has(scene.id)) add(scene.id, `scenes[${sIndex}].id`, `duplicate scene id "${scene.id}"`);
    sceneIds.add(scene.id);
    scene.narration.forEach((block, nIndex) => {
      if (narrationIds.has(block.id)) {
        add(scene.id, `scenes[${sIndex}].narration[${nIndex}].id`, `duplicate narration id "${block.id}" (must be unique across the plan)`);
      }
      narrationIds.add(block.id);
    });
  });
}

function checkScene(scene: Scene, path: string, language: Language, add: AddIssue): void {
  const at = (field: string, message: string) => add(scene.id, `${path}.${field}`, message);
  const rule = COMPONENT_CATALOG[scene.type];

  // Narration: count, length and script.
  if (scene.narration.length > SCENE_LIMITS.maxNarrationBlocks) {
    at("narration", `has ${scene.narration.length} narration blocks; the limit is ${SCENE_LIMITS.maxNarrationBlocks}`);
  }
  scene.narration.forEach((block, i) => {
    if (block.text.length > SCENE_LIMITS.maxNarrationBlockLength) {
      at(`narration[${i}].text`, `is ${block.text.length} characters; the limit is ${SCENE_LIMITS.maxNarrationBlockLength}. Split it into two blocks.`);
    }
    const displayField = block.display === null ? "text" : "display";
    const scriptProblem = checkDisplayScript(block.display ?? block.text, language);
    if (scriptProblem) at(`narration[${i}].${displayField}`, scriptProblem);
  });

  // Objects: unique IDs, catalog kinds, label lengths, values, counts.
  const objectIds = new Set<string>();
  const kindTotals: Record<string, number> = {};
  scene.objects.forEach((obj, i) => {
    if (objectIds.has(obj.id)) at(`objects[${i}].id`, `duplicate object id "${obj.id}"`);
    objectIds.add(obj.id);

    const kindRule = rule.kinds[obj.kind];
    if (!kindRule) {
      at(`objects[${i}].kind`, `kind "${obj.kind}" is not allowed in a ${scene.type} scene; allowed kinds: ${Object.keys(rule.kinds).join(", ")}`);
      return;
    }
    kindTotals[obj.kind] = (kindTotals[obj.kind] ?? 0) + 1;
    if (obj.label.length > kindRule.maxLabelLength) {
      at(`objects[${i}].label`, `"${obj.label}" is ${obj.label.length} characters; the limit for a ${obj.kind} is ${kindRule.maxLabelLength}`);
    }
    if (kindRule.requiresValue && obj.value === null) {
      at(`objects[${i}].value`, `a ${obj.kind} needs a numeric value`);
    }
    if (!kindRule.requiresValue && obj.value !== null) {
      at(`objects[${i}].value`, `a ${obj.kind} does not use a value; remove it or use a chart kind`);
    }
    const scriptProblem = checkDisplayScript(obj.label, language);
    if (scriptProblem) at(`objects[${i}].label`, scriptProblem);
  });
  if (scene.objects.length < rule.minObjects || scene.objects.length > rule.maxObjects) {
    at("objects", `a ${scene.type} scene needs ${rule.minObjects}-${rule.maxObjects} objects, but has ${scene.objects.length}`);
  }
  for (const [kind, { min, max }] of Object.entries(rule.kindCounts ?? {})) {
    const count = kindTotals[kind] ?? 0;
    if (count < min || count > max) {
      const expected = min === max ? `exactly ${min}` : `${min}-${max}`;
      at("objects", `a ${scene.type} scene needs ${expected} "${kind}" object(s), but has ${count}`);
    }
  }

  // Events: limits, catalog actions, anchors and targets.
  if (scene.events.length > SCENE_LIMITS.maxEvents) {
    at("events", `has ${scene.events.length} events; the limit is ${SCENE_LIMITS.maxEvents}`);
  }
  const eventIds = new Set<string>();
  scene.events.forEach((event, i) => {
    if (eventIds.has(event.id)) at(`events[${i}].id`, `duplicate event id "${event.id}"`);
    eventIds.add(event.id);

    if (!rule.actions.includes(event.action)) {
      at(`events[${i}].action`, `action "${event.action}" is not allowed in a ${scene.type} scene; allowed actions: ${rule.actions.join(", ")}`);
    }
    if (!objectIds.has(event.target)) {
      at(`events[${i}].target`, `target "${event.target}" is not an object in this scene; objects here: ${[...objectIds].join(", ") || "(none)"}`);
    }
    const block = scene.narration.find((b) => b.id === event.anchor.narrationId);
    if (!block) {
      at(`events[${i}].anchor.narrationId`, `narration block "${event.anchor.narrationId}" does not exist in this scene`);
      return;
    }
    const matches = countPhrase(block.text, event.anchor.phrase);
    if (matches === 0) {
      at(`events[${i}].anchor.phrase`, `phrase "${event.anchor.phrase}" was not found in narration block "${block.id}": "${block.text}"`);
    } else if (matches > 1) {
      at(`events[${i}].anchor.phrase`, `phrase "${event.anchor.phrase}" appears ${matches} times in narration block "${block.id}"; use a longer phrase so the cue is unambiguous`);
    }
  });
}

function checkWarningsAndSources(plan: Plan, add: AddIssue): void {
  const sceneIds = new Set(plan.scenes.map((s) => s.id));
  plan.warnings.forEach((w, i) => {
    if (w.sceneId !== null && !sceneIds.has(w.sceneId)) {
      add(null, `warnings[${i}].sceneId`, `warning refers to scene "${w.sceneId}", which does not exist`);
    }
  });
  const sourceIds = new Set<string>();
  plan.sources.forEach((s, i) => {
    if (sourceIds.has(s.id)) add(null, `sources[${i}].id`, `duplicate source id "${s.id}"`);
    sourceIds.add(s.id);
  });
}

// ---------- helpers ----------

/** Lowercase, Unicode-normalize and collapse whitespace so matching ignores trivial differences. */
function normalizeForMatch(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** Count whole-phrase occurrences (a phrase must not start or end in the middle of a word). */
export function countPhrase(text: string, phrase: string): number {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(phrase);
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    const startsAtBoundary = before === undefined || !WORD_CHAR.test(before);
    const endsAtBoundary = after === undefined || !WORD_CHAR.test(after);
    if (startsAtBoundary && endsAtBoundary) count++;
    from = index + 1;
  }
  return count;
}

const DEVANAGARI = /\p{Script=Devanagari}/gu;
const LATIN = /\p{Script=Latin}/gu;
/** Hindi text may contain a few Roman acronyms (e.g. "DNA"); above this share it is not Hindi script. */
const MAX_LATIN_SHARE_IN_HINDI = 0.2;

/**
 * [ByteReel] Captions/labels must be in the right script:
 * - Hindi (hi): Devanagari (a few Roman acronyms allowed).
 * - Hinglish: Roman script only; Devanagari belongs in `speech`, never on screen.
 * Returns a human-readable problem, or null when the text is fine.
 */
export function checkDisplayScript(text: string, language: Language): string | null {
  const devanagari = text.match(DEVANAGARI)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (language === "hi") {
    if (devanagari === 0 || latin / (devanagari + latin) > MAX_LATIN_SHARE_IN_HINDI) {
      return `Hindi on-screen text must be written in Devanagari: "${text}"`;
    }
  }
  if (language === "hinglish" && devanagari > 0) {
    return `Hinglish on-screen text must be in Roman script, but contains Devanagari: "${text}". ` +
      `Put the Devanagari version in "speech" and keep Roman script in "text"/"display".`;
  }
  return null;
}

/** Count words in what will actually be spoken (speech when present, otherwise text). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => WORD_CHAR.test(word)).length;
}

function estimateDuration(plan: Plan): PlanStats {
  const wordCount = plan.scenes
    .flatMap((scene) => scene.narration)
    .reduce((sum, block) => sum + countWords(block.speech ?? block.text), 0);
  const seconds = (wordCount / WORDS_PER_MINUTE[plan.language]) * 60;
  return { sceneCount: plan.scenes.length, wordCount, estimatedSeconds: Math.round(seconds * 10) / 10 };
}

function wordsFor(seconds: number, language: Language): number {
  return Math.round((seconds / 60) * WORDS_PER_MINUTE[language]);
}
