import type { Plan, Scene } from "../contracts";
import { COMPONENT_CATALOG, WORDS_PER_MINUTE } from "./component-catalog";
import { iconFor } from "./icon-catalog";
import { countWords, validatePlanSemantics, type PlanStats } from "./semantic-validation";

/**
 * Static storyboard review page (PIPELINE_DESIGN.md §3 "Storyboard review", plan-review.html).
 * Self-contained HTML (inline CSS, no scripts, no network). Every plan string is HTML-escaped.
 */

export interface ReviewPageInfo {
  plan: Plan;
  planHash: string;
  stats: PlanStats;
  runId: string;
  plannerModel: string;
  generatedAt: string;
  /** e.g. "Repaired once after validation errors" */
  plannerNote: string | null;
  approveCommand: string;
}

const PATTERN_LABEL: Record<string, string> = {
  "title-hook": "Title hook",
  "labeled-diagram": "Labelled diagram",
  "process-flow": "Process flow",
  comparison: "Comparison",
  timeline: "Timeline",
  chart: "Chart",
  "step-sequence": "Step sequence",
  takeaway: "Takeaway",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find a phrase in text as whole words, case-insensitive, whitespace-tolerant. */
export function findPhrase(text: string, phrase: string): { start: number; end: number } | null {
  const words = phrase.normalize("NFC").trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  if (!words.length) return null;
  const pattern = new RegExp(`(?<!${WORD_CHAR})${words.join("\\s+")}(?!${WORD_CHAR})`, "iu");
  const match = pattern.exec(text.normalize("NFC"));
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

interface Mark {
  start: number;
  end: number;
  labels: number[];
}

/** Narration text with every event anchor highlighted and numbered. */
export function highlightNarration(text: string, anchors: { phrase: string; eventNumber: number }[]): string {
  const normalized = text.normalize("NFC");
  const marks: Mark[] = [];
  for (const anchor of anchors) {
    const range = findPhrase(normalized, anchor.phrase);
    if (!range) continue;
    const same = marks.find((m) => m.start === range.start && m.end === range.end);
    if (same) {
      same.labels.push(anchor.eventNumber);
      continue;
    }
    if (marks.some((m) => range.start < m.end && m.start < range.end)) continue; // overlapping: listed below, not marked
    marks.push({ ...range, labels: [anchor.eventNumber] });
  }
  marks.sort((a, b) => a.start - b.start);
  let html = "";
  let at = 0;
  for (const mark of marks) {
    html += escapeHtml(normalized.slice(at, mark.start));
    html += `<mark>${escapeHtml(normalized.slice(mark.start, mark.end))}<sup>${mark.labels.join(",")}</sup></mark>`;
    at = mark.end;
  }
  return html + escapeHtml(normalized.slice(at));
}

function sceneCard(scene: Scene, index: number, plan: Plan): string {
  const rule = COMPONENT_CATALOG[scene.type];
  const objectsById = new Map(scene.objects.map((o) => [o.id, o]));
  const words = scene.narration.reduce((sum, b) => sum + countWords(b.speech ?? b.text), 0);
  const seconds = (words / WORDS_PER_MINUTE[plan.language]) * 60;

  const narration = scene.narration
    .map((block) => {
      const anchors = scene.events
        .map((event, i) => ({ event, eventNumber: i + 1 }))
        .filter(({ event }) => event.anchor.narrationId === block.id)
        .map(({ event, eventNumber }) => ({ phrase: event.anchor.phrase, eventNumber }));
      const extra = [
        block.speech ? `<div class="alt"><span>Speech:</span> ${escapeHtml(block.speech)}</div>` : "",
        block.display ? `<div class="alt"><span>Captions:</span> ${escapeHtml(block.display)}</div>` : "",
      ].join("");
      return `<div class="line"><div class="line-id">${escapeHtml(block.id)}</div><p>${highlightNarration(block.text, anchors)}</p>${extra}</div>`;
    })
    .join("");

  const objects = scene.objects
    .map(
      (o) =>
        `<tr><td><code>${escapeHtml(o.id)}</code></td><td>${escapeHtml(o.kind)}</td><td>${escapeHtml(o.label)}</td>` +
        `<td>${o.value === null ? "" : escapeHtml(String(o.value))}</td><td class="muted">${escapeHtml(iconFor(o))}${o.icon ? "" : " (from label)"}</td></tr>`,
    )
    .join("");

  const events = scene.events
    .map((e, i) => {
      const target = objectsById.get(e.target);
      return (
        `<li><span class="num">${i + 1}</span><strong>${escapeHtml(e.action)}</strong> → ${escapeHtml(target?.label ?? e.target)} ` +
        `<span class="muted">(<code>${escapeHtml(e.target)}</code>)</span> on “${escapeHtml(e.anchor.phrase)}”</li>`
      );
    })
    .join("");

  const warnings = [
    ...plan.warnings.filter((w) => w.sceneId === scene.id).map((w) => w.message),
    ...validatePlanSemantics(plan).warnings.filter((w) => w.sceneId === scene.id).map((w) => `Label: ${w.message}`),
  ];
  const warningHtml = warnings.length
    ? `<div class="warn"><strong>Check:</strong><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
    : "";

  return `<section class="scene">
  <header>
    <span class="scene-no">${index + 1}</span>
    <div>
      <div class="pattern">${escapeHtml(PATTERN_LABEL[scene.type] ?? scene.type)} <span class="muted">· ${escapeHtml(rule.description)}</span></div>
      <div class="scene-id"><code>${escapeHtml(scene.id)}</code> · ${words} words · ~${seconds.toFixed(1)} s</div>
    </div>
  </header>
  <h3>Narration</h3>
  ${narration}
  <h3>Visual objects</h3>
  <table><thead><tr><th>ID</th><th>Kind</th><th>Label (on screen)</th><th>Value</th><th>Icon</th></tr></thead><tbody>${objects || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table>
  <h3>Events <span class="muted">(numbers match the highlighted phrases)</span></h3>
  <ol class="events">${events || '<li class="muted">none</li>'}</ol>
  ${warningHtml}
</section>`;
}

export function renderPlanReview(info: ReviewPageInfo): string {
  const { plan, stats } = info;
  const general = plan.warnings.filter((w) => w.sceneId === null);
  const totalWarnings = plan.warnings.length;
  const sources = plan.sources
    .map((s) => `<details><summary>${escapeHtml(s.title)}</summary><pre>${escapeHtml(s.notes)}</pre></details>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storyboard review: ${escapeHtml(plan.topic)}</title>
<style>
  :root { --ink:#1b1f2a; --muted:#6b7280; --line:#e5e7eb; --bg:#f6f7fb; --card:#fff; --accent:#2563eb; --warm:#f59e0b; --mark:#fde68a; --warnbg:#fff7e6; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; line-height:1.2; margin: 8px 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 12px; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 8px; }
  .status { display:inline-block; background:#fef3c7; color:#92400e; border-radius:999px; padding:2px 12px; font-size:13px; font-weight:600; }
  .objective { font-size: 18px; margin: 8px 0 20px; }
  .facts { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 8px; }
  .fact { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .fact .k { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .fact .v { font-weight:600; overflow-wrap:anywhere; }
  .approve { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:10px; padding:12px 16px; margin-top:16px; }
  .approve code { display:block; white-space:pre-wrap; overflow-wrap:anywhere; background:#f3f4f6; padding:8px 10px; border-radius:6px; margin-top:6px; font-size:13px; }
  .scene { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin: 16px 0; }
  .scene header { display:flex; gap:14px; align-items:center; }
  .scene-no { flex:none; width:36px; height:36px; border-radius:50%; background:var(--accent); color:#fff; display:grid; place-items:center; font-weight:700; }
  .pattern { font-weight:700; }
  .scene-id { font-size:13px; color:var(--muted); }
  .line { border-left:3px solid var(--line); padding: 2px 0 2px 12px; margin: 8px 0; }
  .line p { margin: 0; font-size: 17px; }
  .line-id { font-size:12px; color:var(--muted); font-family: ui-monospace, monospace; }
  .alt { font-size:14px; color:var(--muted); } .alt span { font-weight:600; }
  mark { background:var(--mark); border-radius:3px; padding:0 2px; }
  mark sup { font-size:10px; font-weight:700; color:#92400e; margin-left:2px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  .events { padding-left: 0; list-style:none; margin:0; font-size:15px; }
  .events li { padding:4px 0; }
  .num { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%; background:var(--mark); color:#92400e; font-size:11px; font-weight:700; margin-right:6px; }
  .muted { color:var(--muted); font-weight:400; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  .warn { background:var(--warnbg); border:1px solid #fcd34d; border-radius:10px; padding:10px 14px; margin-top:14px; }
  .warn ul { margin:4px 0 0; padding-left: 20px; }
  details { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
  pre { white-space:pre-wrap; font-size:13px; }
  footer { color:var(--muted); font-size:13px; margin-top:32px; }
  @media (max-width: 560px) { th:nth-child(5), td:nth-child(5) { display:none; } }
</style>
</head>
<body>
<main>
  <span class="status">Awaiting approval · not approved</span>
  <h1>${escapeHtml(plan.topic)}</h1>
  <p class="objective">${escapeHtml(plan.learningObjective)}</p>
  <div class="facts">
    <div class="fact"><div class="k">Audience</div><div class="v">${escapeHtml(plan.audience)}</div></div>
    <div class="fact"><div class="k">Language · voice</div><div class="v">${escapeHtml(plan.language)} · ${escapeHtml(plan.voicePreset)}</div></div>
    <div class="fact"><div class="k">Estimated duration</div><div class="v">~${stats.estimatedSeconds} s (${stats.wordCount} words at ${WORDS_PER_MINUTE[plan.language]} wpm)</div></div>
    <div class="fact"><div class="k">Scenes · warnings</div><div class="v">${stats.sceneCount} scenes · ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}</div></div>
  </div>
  <p class="muted" style="font-size:14px">Duration is an estimate from the word count; the real length comes from the recorded narration (must be 60–90 s).</p>

  <div class="approve">
    <strong>To approve exactly this storyboard</strong>, run:
    <code>${escapeHtml(info.approveCommand)}</code>
    <div class="muted" style="font-size:13px;margin-top:6px">Plan hash: <code style="display:inline;padding:0;background:none">${escapeHtml(info.planHash)}</code>. Any change to the plan changes the hash and needs a new approval.</div>
  </div>

  ${general.length ? `<h2>General warnings</h2><div class="warn"><ul>${general.map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul></div>` : ""}

  <h2>Storyboard</h2>
  ${plan.scenes.map((scene, i) => sceneCard(scene, i, plan)).join("\n")}

  <h2>Source notes (from the creator)</h2>
  ${sources || '<p class="muted">none</p>'}

  <footer>
    Run <code>${escapeHtml(info.runId)}</code> · planned by ${escapeHtml(info.plannerModel)}${info.plannerNote ? ` (${escapeHtml(info.plannerNote)})` : ""} · ${escapeHtml(info.generatedAt)}<br>
    Live planner output, validated against the plan schema and the component catalog. Visuals are drawn from a fixed component library; each object's icon comes from its <code>icon</code> field, or from label keywords when it has none.
  </footer>
</main>
</body>
</html>
`;
}
