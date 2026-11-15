import type { IconName } from "./icon-catalog";

/**
 * Hero object catalog (F22b, video style v4): the big illustrated OBJECT shown in the middle of the
 * frame while a narration block is spoken ("one hero per sentence").
 *
 * Like the icon catalog, it lives in planning (not video) so the planner prompt, the timeline
 * compiler, the storyboard screen and the Remotion hero library share one list. The SVG artwork is
 * in packages/video/src/heroes/. Pure TypeScript with no imports at runtime: safe for the browser.
 *
 * Keywords are for the free, deterministic FALLBACK when a block has no planner-picked `hero`:
 * a word names a hero when it equals a keyword, or a keyword plus a common ending (s, es, ed, ing,
 * er, y, ...). A keyword ending in "*" is a stem and matches any ending ("evaporat*" matches
 * "evaporates", "evaporation"). The longest matching keyword wins, so "cardiac" is a heart, not a
 * credit card. Avoid generic verbs ("rise", "grow", "return"): they appear in every topic.
 */

export const HERO_NAMES = [
  // nature and the water cycle (the approved v4 sample objects)
  "chai-cup", "dinosaur", "glacier", "rain-cloud", "cloud", "vapour", "sun", "groundwater", "river", "ocean", "drop", "globe",
  // money and finance
  "coin-stack", "wallet", "bank", "piggy-bank", "growth-chart", "calculator", "credit-card", "house",
  // technology
  "smartphone", "laptop", "server", "wifi", "shield-lock", "chip",
  // science and health
  "atom", "dna", "heart", "brain", "plant", "flask", "virus", "magnet", "lightbulb",
  // time and places
  "clock", "calendar", "map-pin", "mountain", "factory", "truck",
  // generic
  "target", "rocket", "trophy", "question-mark", "checklist",
] as const;
export type HeroName = (typeof HERO_NAMES)[number];

export type HeroGroup = "nature" | "money" | "tech" | "science" | "places" | "generic";

export interface HeroDef {
  name: HeroName;
  /** Plain words for people (storyboard "Visual:" line, planner prompt). */
  title: string;
  group: HeroGroup;
  /** Objects of one family morph into each other instead of swapping (cloud -> rain cloud). */
  family: string;
  /**
   * The small icon that shows the same thing. When this hero is on screen, a card or step tile
   * with this icon hides it, so the same object is never shown twice at once. null: no icon matches.
   */
  icon: IconName | null;
  /** Lowercase keywords for the fallback match (see the file comment). */
  keywords: readonly string[];
}

const def = (name: HeroName, title: string, group: HeroGroup, icon: IconName | null, keywords: string[], family: string = name): HeroDef => ({
  name,
  title,
  group,
  family,
  icon,
  keywords,
});

/** Catalog order is the tie-break when two keywords of the same length match. */
export const HERO_CATALOG: readonly HeroDef[] = [
  def("chai-cup", "chai cup", "nature", "glass", ["chai", "tea", "cup", "coffee", "mug"]),
  def("dinosaur", "dinosaur", "nature", null, ["dinosaur", "dino", "jurassic", "prehistoric", "fossil"]),
  def("glacier", "glacier", "nature", "snowflake", ["glacier", "iceberg", "ice", "frozen", "polar", "arctic", "antarctic"]),
  def("rain-cloud", "rain cloud", "nature", "raindrop", ["rain", "rainfall", "precipitat*", "snow", "hail", "storm", "monsoon", "drizzle", "heavier"], "cloud"),
  def("cloud", "cloud", "nature", "cloud", ["cloud", "condens*", "fog", "mist"], "cloud"),
  def("vapour", "water vapour", "nature", "droplets", ["vapour", "vapor", "steam", "evaporat*", "humid*"]),
  def("sun", "sun", "nature", "sun", ["sun", "sunlight", "sunshine", "solar", "heat"]),
  def("groundwater", "groundwater", "nature", "layers", ["groundwater", "underground", "soil", "aquifer", "seep"], "land"),
  def("river", "river", "nature", "waves", ["river", "stream", "flow", "canal", "waterfall"], "land"),
  def("ocean", "ocean", "nature", "waves", ["ocean", "sea", "lake", "salt", "salty", "marine", "beach", "wave"]),
  def("drop", "water drop", "nature", "raindrop", ["droplet", "drop", "fresh", "thirst*"]),
  def("globe", "globe", "nature", "globe", ["earth", "planet", "world", "globe", "global", "country", "countries", "international"]),

  def("coin-stack", "rupee coins", "money", "coin", ["rupee", "coin", "money", "cash", "price", "cost", "paise", "salary", "income", "earn", "fee", "paisa"]),
  def("wallet", "wallet", "money", null, ["wallet", "spend", "spending", "expense", "budget", "purse", "pocket"]),
  def("bank", "bank", "money", "bank", ["bank", "deposit", "account", "loan", "branch", "rbi", "fd"]),
  def("piggy-bank", "piggy bank", "money", null, ["piggy", "saving", "savings", "save"]),
  def("growth-chart", "growth chart", "money", "chart", ["growth", "invest*", "profit", "stock", "sensex", "nifty", "compound", "mutual", "sip", "portfolio"]),
  def("calculator", "calculator", "money", null, ["calculat*", "emi", "tax", "taxes", "math", "maths", "arithmetic", "formula"]),
  def("credit-card", "credit card", "money", null, ["card", "credit", "debit", "upi", "payment", "swipe", "transaction"]),
  def("house", "house", "money", null, ["house", "home", "rent", "property", "mortgage", "apartment"]),

  def("smartphone", "smartphone", "tech", null, ["phone", "smartphone", "mobile", "app", "whatsapp", "android", "iphone"]),
  def("laptop", "laptop", "tech", null, ["laptop", "computer", "software", "code", "coding", "program", "programming", "website", "browser"]),
  def("server", "server", "tech", null, ["server", "database", "datacenter", "datacentre", "backend", "hosting", "storage"]),
  def("wifi", "wi-fi signal", "tech", null, ["wifi", "signal", "network", "internet", "wireless", "router", "online"]),
  def("shield-lock", "lock and shield", "tech", null, ["security", "secure", "safe", "safety", "lock", "password", "privacy", "protect*", "shield", "hack", "hacker", "scam", "fraud", "otp"]),
  def("chip", "microchip", "tech", null, ["chip", "microchip", "processor", "cpu", "gpu", "semiconductor", "silicon", "transistor", "circuit"]),

  def("atom", "atom", "science", null, ["atom", "atomic", "electron", "proton", "neutron", "nucleus", "molecule", "nuclear"]),
  def("dna", "DNA", "science", null, ["dna", "gene", "genetic", "genetics", "chromosome", "heredity", "mutation"]),
  def("heart", "heart", "science", null, ["heart", "blood", "heartbeat", "cardiac", "circulation"]),
  def("brain", "brain", "science", null, ["brain", "mind", "memory", "memories", "neuron", "nerve", "thinking", "focus", "habit"]),
  def("plant", "plant", "science", "leaf", ["plant", "leaf", "leaves", "tree", "seed", "photosynth*", "crop", "farm", "forest"]),
  def("flask", "lab flask", "science", null, ["flask", "chemical", "chemistry", "experiment", "lab", "laboratory", "reaction", "acid"]),
  def("virus", "virus", "science", null, ["virus", "viruses", "bacteria", "germ", "infection", "disease", "vaccine", "immune", "immunity", "flu"]),
  def("magnet", "magnet", "science", null, ["magnet", "magnetic", "magnetism", "compass"]),
  def("lightbulb", "light bulb", "science", "bulb", ["idea", "bulb", "lightbulb", "electricity", "electric", "invention", "invent", "innovation", "insight"]),

  def("clock", "clock", "places", "clock", ["clock", "time", "hour", "minute", "deadline", "timer", "duration", "late"]),
  def("calendar", "calendar", "places", null, ["calendar", "date", "schedule", "month", "monthly", "week", "weekly", "weekend"]),
  def("map-pin", "map pin", "places", null, ["map", "location", "place", "city", "cities", "address", "gps", "route", "direction", "travel"]),
  def("mountain", "mountain", "places", "mountain", ["mountain", "hill", "himalaya*", "peak", "summit", "everest", "altitude"]),
  def("factory", "factory", "places", null, ["factory", "factories", "industry", "industrial", "manufactur*", "pollution", "smoke", "emission", "carbon"]),
  def("truck", "delivery truck", "places", null, ["truck", "delivery", "deliver", "shipping", "transport", "logistics", "supply", "road", "highway", "vehicle"]),

  def("target", "target", "generic", null, ["target", "goal", "aim", "objective", "bullseye", "accuracy"]),
  def("rocket", "rocket", "generic", null, ["rocket", "launch", "space", "isro", "nasa", "startup", "boost"]),
  def("trophy", "trophy", "generic", "star", ["trophy", "winner", "winning", "champion", "success", "successful", "achievement", "award", "prize", "medal"]),
  def("question-mark", "question mark", "generic", "question", ["question", "mystery", "wonder", "curious", "curiosity", "puzzle", "quiz", "confus*"]),
  def("checklist", "checklist", "generic", "check", ["checklist", "list", "steps", "tips", "rules", "todo", "tasks"]),
];

const BY_NAME = new Map<string, HeroDef>(HERO_CATALOG.map((d) => [d.name, d]));

export function isHeroName(value: unknown): value is HeroName {
  return typeof value === "string" && BY_NAME.has(value);
}

export function heroDef(name: HeroName): HeroDef {
  return BY_NAME.get(name)!;
}

/** "chai cup" for "chai-cup". */
export function heroTitle(name: HeroName): string {
  return heroDef(name).title;
}

/** Endings a plain keyword may take: "cloud" matches "clouds", "rain" matches "raining". */
const ENDINGS = ["", "s", "es", "ed", "ing", "er", "ers", "y", "ies"];

/** Words that look like a keyword plus an ending but mean something else. */
const NOT_HEROES = new Set(["streaming", "streamer", "streamers", "flower", "flowers", "pulses", "lately"]);

/**
 * Lowercase and keep letters, combining marks (Devanagari vowel signs), digits and "%". Apostrophes
 * and punctuation go, so "Earth's" becomes "earths" and "rain," becomes "rain".
 */
export function normalizeHeroWord(text: string): string {
  return text.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}\p{N}%]/gu, "");
}

/** Length of the keyword that `word` matches (0 when it does not). `word` is already normalized. */
function matchLength(word: string, keyword: string): number {
  if (keyword.endsWith("*")) {
    const stem = keyword.slice(0, -1);
    return word.startsWith(stem) ? stem.length : 0;
  }
  return ENDINGS.some((ending) => word === keyword + ending) ? keyword.length : 0;
}

/** The hero a single word names, if any (longest keyword wins, then catalog order). */
export function heroForWord(word: string): HeroName | null {
  const w = normalizeHeroWord(word);
  if (w.length < 2 || NOT_HEROES.has(w)) return null;
  let best: { name: HeroName; length: number } | null = null;
  for (const hero of HERO_CATALOG) {
    for (const keyword of hero.keywords) {
      const length = matchLength(w, keyword);
      if (length > 0 && (!best || length > best.length)) best = { name: hero.name, length };
    }
  }
  return best?.name ?? null;
}

/** The first hero named in a text (label or narration), word by word, if any. */
export function heroForText(text: string): HeroName | null {
  for (const word of text.split(/[\s()/,.;:!?"“”‘’—–-]+/u)) {
    const hit = heroForWord(word);
    if (hit) return hit;
  }
  return null;
}

/** The hero that shows the same thing as an icon (for an object without a matching label). */
export function heroForIcon(icon: IconName | null | undefined): HeroName | null {
  if (!icon) return null;
  return HERO_CATALOG.find((d) => d.icon === icon)?.name ?? null;
}

/** true when the icon shows the same thing as the hero (so it is hidden while the hero is on screen). */
export function iconDuplicatesHero(icon: IconName | null | undefined, hero: HeroName | null | undefined): boolean {
  return !!icon && !!hero && heroDef(hero).icon === icon;
}

/** One line per hero for the planner prompt: name, what it shows, and the topics it suits. */
export function heroPromptRows(): string[] {
  return HERO_CATALOG.map((d) => {
    const hints = d.keywords.slice(0, 6).map((k) => k.replace(/\*$/, "")).join(", ");
    return `- ${d.name}: ${d.title} (${hints})`;
  });
}
