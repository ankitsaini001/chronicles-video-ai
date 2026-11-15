/**
 * Smooth paths through points (Catmull-Rom -> cubic Bezier) with arc-length lookup, so a glowing
 * path can be drawn to any progress and a light dot can travel along it at an even speed.
 * Pure maths: no DOM measuring, so it works the same in every render.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Spline {
  d: string;
  length: number;
  /** Point and direction (degrees) at fraction t (0..1) of the path length. */
  at(t: number): Pt & { angle: number };
}

type Segment = [Pt, Pt, Pt, Pt];

const bez = (s: Segment, t: number): Pt => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y };
};

export function spline(points: Pt[], tension = 1): Spline {
  if (points.length < 2) throw new Error("spline needs at least 2 points");
  const segs: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const k = tension / 6;
    segs.push([p1, { x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k }, { x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k }, p2]);
  }
  const f = (n: number) => n.toFixed(1);
  const d = `M ${f(points[0]!.x)} ${f(points[0]!.y)} ` + segs.map((s) => `C ${f(s[1].x)} ${f(s[1].y)} ${f(s[2].x)} ${f(s[2].y)} ${f(s[3].x)} ${f(s[3].y)}`).join(" ");

  // Arc-length table.
  const samples: Pt[] = [];
  const lengths: number[] = [0];
  const N = 48;
  segs.forEach((s, si) => {
    for (let j = si === 0 ? 0 : 1; j <= N; j++) samples.push(bez(s, j / N));
  });
  for (let i = 1; i < samples.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y));
  }
  const length = lengths[lengths.length - 1]!;

  const at = (t: number) => {
    const target = Math.max(0, Math.min(1, t)) * length;
    let lo = 0, hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid]! < target) lo = mid;
      else hi = mid;
    }
    const span = lengths[hi]! - lengths[lo]! || 1;
    const k = (target - lengths[lo]!) / span;
    const a = samples[lo]!, b = samples[hi]!;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
  };
  return { d, length, at };
}

/** SVG arc path for a ring slice (angles in degrees, 0 = 12 o'clock, clockwise). */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const p = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const a = p(fromDeg), b = p(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function polar(cx: number, cy: number, r: number, deg: number): Pt {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
