import type { Plan, Scene } from "../contracts";
import { normalizeHeroWord } from "../planning/hero-catalog";

/**
 * Key terms in captions (F22b, video style v4): words shown in amber. A caption word is a key term
 * when it is a number, or when it names something on screen in its scene: it shares a stem with a
 * word of one of the scene's object labels. Topic words ("water" in a water-cycle video) and short
 * function words are never key terms, so the amber stays rare and meaningful. Pure, deterministic.
 */

const STOPWORDS = new Set(
  "the a an of and or to in into is are was be by for from on at as that this it its our your you we with where does go what how why who will can just about not all".split(" "),
);

/** Stems of a text's meaningful words: lowercase, no punctuation, at least 3 letters, without a final "s". */
function stems(text: string, skip: ReadonlySet<string>): string[] {
  return text
    .split(/\s+/)
    .map(normalizeHeroWord)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !skip.has(w))
    .map((w) => w.replace(/s$/, ""));
}

export function keyTermTest(plan: Pick<Plan, "topic">): (scene: Pick<Scene, "objects">, text: string) => boolean {
  const topic = new Set(plan.topic.split(/\s+/).map(normalizeHeroWord).filter((w) => w.length >= 3));
  const cache = new WeakMap<object, string[]>();
  return (scene, text) => {
    const word = normalizeHeroWord(text);
    if (/\p{N}/u.test(word)) return true;
    if (word.length < 3 || STOPWORDS.has(word) || topic.has(word) || topic.has(word.replace(/s$/, ""))) return false;
    let labelStems = cache.get(scene);
    if (!labelStems) {
      labelStems = scene.objects.flatMap((o) => stems(o.label, topic));
      cache.set(scene, labelStems);
    }
    return labelStems.some((stem) => word.startsWith(stem) || (stem.startsWith(word) && word.length >= 3));
  };
}
